"""Colour conversion shared by the renderer and a Blender PNG round-trip test."""
import numpy as np

def decode_png_pixels(data):
    result = data.copy()
    rgb = result[:, :3]
    result[:, :3] = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    return result

def combine_passes(beauty, source):
    result = decode_png_pixels(beauty)
    contribution = decode_png_pixels(source)
    result[:, :3] += contribution[:, :3] * contribution[:, 3:4]
    result[:, 3] = 1
    return result
