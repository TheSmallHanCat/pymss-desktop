
import torch
import torch.nn as nn
import torch.nn.functional as F


class Attention(nn.Module):
    def __init__(self, dim, heads=4, dim_head=32, conditiondim=None):
        super().__init__()
        if conditiondim is None:
            conditiondim = dim

        self.scale = dim_head ** -0.5
        self.heads = heads
        hidden_dim = dim_head * heads
        self.to_q = nn.Linear(dim, hidden_dim, bias=False)
        self.to_kv = nn.Linear(conditiondim, hidden_dim * 2, bias=False)

        self.to_out = nn.Sequential(nn.Linear(hidden_dim, dim, ),
                                    )

    def forward(self, q, kv=None, mask=None):
        # b, c, h, w = x.shape
        if kv is None:
            kv = q
        # q, kv = map(
        #     lambda t: rearrange(t, "b c t -> b t c", ), (q, kv)
        # )

        q = self.to_q(q)
        k, v = self.to_kv(kv).chunk(2, dim=2)

        q, k, v = map(
            lambda tensor: tensor.reshape(
                tensor.shape[0], tensor.shape[1], self.heads, tensor.shape[2] // self.heads
            ).permute(0, 2, 1, 3),
            (q, k, v),
        )

        if mask is not None:
            mask = mask.unsqueeze(1).unsqueeze(1)

        out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)

        batch, _, steps, _ = out.shape
        out = out.permute(0, 2, 1, 3).contiguous().reshape(batch, steps, -1)
        return self.to_out(out)
