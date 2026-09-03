import torch
import torch.nn as nn
import torch.nn.functional as F


def rotate_half(x: torch.Tensor) -> torch.Tensor:
    half = x.shape[-1] // 2
    return torch.cat((-x[..., half:], x[..., :half]), dim=-1)


def apply_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor):
    cos = cos.unsqueeze(1)
    sin = sin.unsqueeze(1)
    return (q * cos) + (rotate_half(q) * sin), (k * cos) + (rotate_half(k) * sin)


def expand_kv(states: torch.Tensor, groups: int) -> torch.Tensor:
    batch, heads, seq, dim = states.shape
    states = states[:, :, None, :, :].expand(batch, heads, groups, seq, dim)
    return states.reshape(batch, heads * groups, seq, dim)


class UnifiedDecoder(nn.Module):
    def __init__(self, text_model: nn.Module, lm_head: nn.Module):
        super().__init__()
        self.text_model = text_model
        self.lm_head = lm_head
        config = text_model.config
        self.num_heads = config.num_attention_heads
        self.num_kv_heads = config.num_key_value_heads
        self.head_dim = config.head_dim
        self.groups = self.num_heads // self.num_kv_heads

    def forward(self, inputs_embeds, cos, sin, mask, deepstack0, deepstack1, deepstack2, *past):
        deepstack = [deepstack0, deepstack1, deepstack2]
        hidden_states = inputs_embeds
        fresh = []
        for index, layer in enumerate(self.text_model.layers):
            attn = layer.self_attn
            residual = hidden_states
            normed = layer.input_layernorm(hidden_states)
            batch, seq, _ = normed.shape

            query = attn.q_norm(attn.q_proj(normed).view(batch, seq, self.num_heads, self.head_dim)).transpose(1, 2)
            key = attn.k_norm(attn.k_proj(normed).view(batch, seq, self.num_kv_heads, self.head_dim)).transpose(1, 2)
            value = attn.v_proj(normed).view(batch, seq, self.num_kv_heads, self.head_dim).transpose(1, 2)
            query, key = apply_rope(query, key, cos, sin)

            new_key = key.squeeze(0).transpose(0, 1)
            new_value = value.squeeze(0).transpose(0, 1)

            past_key = past[index * 2].transpose(0, 1).unsqueeze(0)
            past_value = past[index * 2 + 1].transpose(0, 1).unsqueeze(0)
            full_key = torch.cat((past_key, key), dim=2)
            full_value = torch.cat((past_value, value), dim=2)

            attn_output = F.scaled_dot_product_attention(
                query,
                expand_kv(full_key, self.groups),
                expand_kv(full_value, self.groups),
                attn_mask=mask,
                dropout_p=0.0,
                is_causal=False,
                scale=attn.scaling,
            )
            attn_output = attn_output.transpose(1, 2).reshape(batch, seq, -1)
            hidden_states = residual + attn.o_proj(attn_output)
            hidden_states = hidden_states + layer.mlp(layer.post_attention_layernorm(hidden_states))
            if index < len(deepstack):
                hidden_states = hidden_states + deepstack[index]
            fresh.append(new_key)
            fresh.append(new_value)

        hidden_states = self.text_model.norm(hidden_states)
        logits = self.lm_head(hidden_states[:, -1:, :]).float().squeeze(1)
        return (logits, *fresh)


def kv_names(layers: int, prefix: str) -> list[str]:
    names = []
    for index in range(layers):
        names.append(f"{prefix}_key_{index}")
        names.append(f"{prefix}_value_{index}")
    return names


MASK_FILL = -1e4


def build_mask(seq: int, past: int, device, dtype=torch.float32) -> torch.Tensor:
    total = past + seq
    positions = torch.arange(total, device=device)
    query_positions = torch.arange(past, total, device=device).unsqueeze(-1)
    allowed = positions.unsqueeze(0) <= query_positions
    mask = torch.zeros(1, 1, seq, total, device=device, dtype=dtype)
    mask.masked_fill_(~allowed.view(1, 1, seq, total), MASK_FILL)
    return mask
