import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers.models.qwen3_vl.modeling_qwen3_vl import apply_rotary_pos_emb_vision


def vision_attention(attn: nn.Module, hidden_states: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    seq_length = hidden_states.shape[0]
    query_states, key_states, value_states = (
        attn.qkv(hidden_states).reshape(seq_length, 3, attn.num_heads, -1).permute(1, 0, 2, 3).unbind(0)
    )
    query_states, key_states = apply_rotary_pos_emb_vision(query_states, key_states, cos, sin)
    query_states = query_states.transpose(0, 1).unsqueeze(0)
    key_states = key_states.transpose(0, 1).unsqueeze(0)
    value_states = value_states.transpose(0, 1).unsqueeze(0)
    attn_output = F.scaled_dot_product_attention(
        query_states,
        key_states,
        value_states,
        attn_mask=None,
        dropout_p=0.0,
        is_causal=False,
        scale=attn.scaling,
    )
    attn_output = attn_output.squeeze(0).transpose(0, 1).reshape(seq_length, -1)
    return attn.proj(attn_output)


class VisionTower(nn.Module):
    def __init__(self, visual: nn.Module):
        super().__init__()
        self.visual = visual

    def forward(self, patches: torch.Tensor, pos_embeds: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor):
        visual = self.visual
        hidden_states = visual.patch_embed(patches)
        hidden_states = hidden_states + pos_embeds

        deepstack = []
        for index, block in enumerate(visual.blocks):
            hidden_states = hidden_states + vision_attention(block.attn, block.norm1(hidden_states), cos, sin)
            hidden_states = hidden_states + block.mlp(block.norm2(hidden_states))
            if index in visual.deepstack_visual_indexes:
                merger = visual.deepstack_merger_list[visual.deepstack_visual_indexes.index(index)]
                deepstack.append(merger(hidden_states))

        merged = visual.merger(hidden_states)
        return merged, deepstack[0], deepstack[1], deepstack[2]


def host_position_inputs(visual: nn.Module, grid_thw: torch.Tensor):
    with torch.no_grad():
        pos_embeds = visual.fast_pos_embed_interpolate(grid_thw)
        rotary = visual.rot_pos_emb(grid_thw)
        emb = torch.cat((rotary, rotary), dim=-1)
        return pos_embeds, emb.cos(), emb.sin()


def grid_for(height: int, width: int, patch_size: int) -> torch.Tensor:
    if height % patch_size or width % patch_size:
        raise ValueError(f"Expected {height}x{width} to be a multiple of the patch size {patch_size}")
    return torch.tensor([[1, height // patch_size, width // patch_size]], dtype=torch.long)


def patch_count(grid_thw: torch.Tensor) -> int:
    return int(grid_thw.prod(dim=1).sum().item())
