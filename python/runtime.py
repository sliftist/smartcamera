import json
import time
import types

import torch
from PIL import Image
from safetensors import safe_open
from transformers import AutoConfig, AutoProcessor
from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLModel, Qwen3VLTextRotaryEmbedding

from paths import (
    QWEN_DIR,
    VISION_ENGINE,
    DECODER_ENGINE,
    VISION_POSITIONS,
    IMAGE_HEIGHT,
    IMAGE_WIDTH,
    MAX_CACHE_TOKENS,
    PROFILE_PREFILL,
    PROFILE_DECODE,
)
from trtrun import TrtEngine
from visionExport import grid_for, patch_count
from decoderExport import build_mask

EMBED_WEIGHT = "model.language_model.embed_tokens.weight"


def load_tensor(name: str) -> torch.Tensor:
    index_path = QWEN_DIR / "model.safetensors.index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    shard = index["weight_map"][name]
    with safe_open(str(QWEN_DIR / shard), framework="pt", device="cpu") as handle:
        return handle.get_tensor(name)


class VisionPreprocessor:
    def __init__(self, processor, config):
        self.image_processor = processor.image_processor
        self.config = config

    def patches(self, image: Image.Image) -> torch.Tensor:
        resized = image.convert("RGB").resize((IMAGE_WIDTH, IMAGE_HEIGHT), Image.BICUBIC)
        encoded = self.image_processor(images=resized, do_resize=False, return_tensors="pt")
        grid = encoded["image_grid_thw"]
        expected = grid_for(IMAGE_HEIGHT, IMAGE_WIDTH, self.config.vision_config.patch_size)
        if not torch.equal(grid, expected):
            raise SystemExit(f"Expected grid {expected.tolist()} for {IMAGE_WIDTH}x{IMAGE_HEIGHT}, got {grid.tolist()}")
        return encoded["pixel_values"], grid


class Qwen3VLTensorRT:
    def __init__(self, device: str = "cuda", load_decoder: bool = True):
        self.device = device
        self.config = AutoConfig.from_pretrained(str(QWEN_DIR))
        self.text_config = self.config.text_config
        self.processor = AutoProcessor.from_pretrained(str(QWEN_DIR))
        self.tokenizer = self.processor.tokenizer
        self.preprocessor = VisionPreprocessor(self.processor, self.config)
        self.rope_shim = types.SimpleNamespace(config=self.config)

        print("[runtime] loading engines")
        self.vision = TrtEngine(VISION_ENGINE, device)
        self.decoder = TrtEngine(DECODER_ENGINE, device) if load_decoder else None

        print("[runtime] loading embedding table")
        self.embed = load_tensor(EMBED_WEIGHT).to(dtype=torch.float16)
        print(f"[runtime] embedding table stays on cpu ({self.embed.numel() * 2 / 2 ** 30:.2f} GiB of vram saved)")
        self.rotary = Qwen3VLTextRotaryEmbedding(self.text_config, device=torch.device(device))

        self.layers = self.text_config.num_hidden_layers
        self.kv_heads = self.text_config.num_key_value_heads
        self.head_dim = self.text_config.head_dim
        self.cache = [
            torch.zeros(MAX_CACHE_TOKENS, self.kv_heads, self.head_dim, dtype=torch.float32, device=device)
            for _ in range(self.layers * 2)
        ]
        self.empty_past = self.cache[0][:0]
        self.prefill_outputs = None
        self.decode_outputs = None
        self.vision_outputs = None
        self.zero_step = torch.zeros(1, 1, self.text_config.hidden_size, dtype=torch.float32, device=device)

        grid = grid_for(IMAGE_HEIGHT, IMAGE_WIDTH, self.config.vision_config.patch_size)
        self.grid = grid
        self.image_tokens = patch_count(grid) // (self.config.vision_config.spatial_merge_size ** 2)

        tables = torch.load(str(VISION_POSITIONS), weights_only=True)
        if not torch.equal(tables["grid_thw"], grid):
            raise SystemExit(
                f"Expected {VISION_POSITIONS.name} to hold grid {grid.tolist()}, it holds {tables['grid_thw'].tolist()}"
            )
        self.vision_position_inputs = {
            "pos_embeds": tables["pos_embeds"].to(device, torch.float32),
            "cos": tables["cos"].to(device, torch.float32),
            "sin": tables["sin"].to(device, torch.float32),
        }

    def rope(self, position_ids: torch.Tensor):
        reference = torch.zeros(1, position_ids.shape[-1], 1, dtype=torch.float32, device=self.device)
        return self.rotary(reference, position_ids.to(self.device))

    def encode_image(self, image: Image.Image):
        pixel_values, _ = self.preprocessor.patches(image)
        inputs = {"patches": pixel_values.to(self.device, torch.float32)}
        inputs.update(self.vision_position_inputs)
        outputs = self.vision.run(inputs, self.vision_outputs)
        self.vision_outputs = outputs
        return outputs["image_embeds"], [outputs["deepstack0"], outputs["deepstack1"], outputs["deepstack2"]]

    def build_prompt(self, question: str):
        messages = [{
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": question},
            ],
        }]
        text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        text = text.replace(
            "<|image_pad|>",
            "<|image_pad|>" * self.image_tokens,
        )
        return self.tokenizer(text, return_tensors="pt").input_ids

    def prefill_inputs(self, input_ids, image_embeds, deepstack):
        sequence = input_ids.shape[1]
        if sequence > MAX_CACHE_TOKENS:
            raise SystemExit(f"Expected at most {MAX_CACHE_TOKENS} prompt tokens, got {sequence}")
        ids = input_ids.to(self.device)
        embeds = self.embed[input_ids.view(-1)].view(1, sequence, -1).float().to(self.device)
        image_mask = (ids == self.config.image_token_id).view(-1)
        found = int(image_mask.sum().item())
        if found != self.image_tokens:
            raise SystemExit(f"Expected {self.image_tokens} image placeholder tokens in the prompt, found {found}")
        flat = embeds.view(sequence, -1)
        flat[image_mask] = image_embeds.to(flat.dtype)

        padded = []
        for tensor in deepstack:
            block = torch.zeros(sequence, tensor.shape[-1], dtype=torch.float32, device=self.device)
            block[image_mask] = tensor.to(torch.float32)
            padded.append(block.view(1, sequence, -1))

        position_ids, deltas = Qwen3VLModel.get_rope_index(
            self.rope_shim,
            input_ids=input_ids,
            image_grid_thw=self.grid,
        )
        cos, sin = self.rope(position_ids)
        return embeds, cos, sin, padded, sequence, int(deltas.view(-1)[0].item())

    def run_prefill(self, input_ids, image_embeds, deepstack):
        embeds, cos, sin, padded, sequence, delta = self.prefill_inputs(input_ids, image_embeds, deepstack)

        inputs = {
            "inputs_embeds": embeds,
            "cos": cos,
            "sin": sin,
            "mask": build_mask(sequence, 0, self.device),
            "deepstack0": padded[0],
            "deepstack1": padded[1],
            "deepstack2": padded[2],
        }
        for index in range(self.layers):
            inputs[f"past_key_{index}"] = self.empty_past
            inputs[f"past_value_{index}"] = self.empty_past
        outputs = self.decoder.run(inputs, self.prefill_outputs, profile=PROFILE_PREFILL)
        self.prefill_outputs = outputs
        for index in range(self.layers):
            self.cache[index * 2][:sequence] = outputs[f"new_key_{index}"]
            self.cache[index * 2 + 1][:sequence] = outputs[f"new_value_{index}"]
        return outputs["logits"], sequence, delta

    def run_decode(self, token_id: int, position: int, past_length: int):
        embeds = self.embed[token_id].view(1, 1, -1).float().to(self.device)
        position_ids = torch.full((3, 1, 1), position, dtype=torch.long)
        cos, sin = self.rope(position_ids)
        inputs = {
            "inputs_embeds": embeds,
            "cos": cos,
            "sin": sin,
            "mask": build_mask(1, past_length, self.device),
            "deepstack0": self.zero_step,
            "deepstack1": self.zero_step,
            "deepstack2": self.zero_step,
        }
        for index in range(self.layers):
            inputs[f"past_key_{index}"] = self.cache[index * 2][:past_length]
            inputs[f"past_value_{index}"] = self.cache[index * 2 + 1][:past_length]
        outputs = self.decoder.run(inputs, self.decode_outputs, profile=PROFILE_DECODE)
        self.decode_outputs = outputs
        for index in range(self.layers):
            self.cache[index * 2][past_length] = outputs[f"new_key_{index}"][0]
            self.cache[index * 2 + 1][past_length] = outputs[f"new_value_{index}"][0]
        return outputs["logits"]

    def generate_timed(self, image: Image.Image, question: str, max_new_tokens: int = 32):
        torch.cuda.synchronize()
        started = time.perf_counter()
        image_embeds, deepstack = self.encode_image(image)
        torch.cuda.synchronize()
        after_vision = time.perf_counter()

        input_ids = self.build_prompt(question)
        logits, length, delta = self.run_prefill(input_ids, image_embeds, deepstack)
        torch.cuda.synchronize()
        after_prefill = time.perf_counter()

        stop_ids = {self.tokenizer.eos_token_id, self.config.text_config.eos_token_id}
        produced = []
        token = int(logits.view(-1).argmax().item())
        for step in range(max_new_tokens):
            if token in stop_ids:
                break
            produced.append(token)
            logits = self.run_decode(token, length + step + delta, length + step)
            token = int(logits.view(-1).argmax().item())
        torch.cuda.synchronize()
        finished = time.perf_counter()

        timings = {
            "visionMs": (after_vision - started) * 1000,
            "prefillMs": (after_prefill - after_vision) * 1000,
            "generateMs": (finished - after_prefill) * 1000,
            "modelMs": (finished - started) * 1000,
            "promptTokens": length,
            "outputTokens": len(produced),
        }
        return self.tokenizer.decode(produced, skip_special_tokens=True).strip(), timings

    def generate(self, image: Image.Image, question: str, max_new_tokens: int = 32):
        image_embeds, deepstack = self.encode_image(image)
        input_ids = self.build_prompt(question)
        logits, length, delta = self.run_prefill(input_ids, image_embeds, deepstack)

        stop_ids = {self.tokenizer.eos_token_id, self.config.text_config.eos_token_id}
        produced = []
        token = int(logits.view(-1).argmax().item())
        for step in range(max_new_tokens):
            if token in stop_ids:
                break
            produced.append(token)
            logits = self.run_decode(token, length + step + delta, length + step)
            token = int(logits.view(-1).argmax().item())
        return self.tokenizer.decode(produced, skip_special_tokens=True)
