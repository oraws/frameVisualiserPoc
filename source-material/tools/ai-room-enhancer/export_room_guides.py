"""Export the fixed room plate and structural guides for local AI enhancement."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[2]
ROOM_ID = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "sofa-gallery"
ROOM = ROOT / "public" / "assets" / "rooms" / ROOM_ID
OUT = ROOM / "enhancement-source"
BLEND = ROOT / "tools" / "room-template-generator" / f"{ROOM_ID}.blend"


def file_output(nodes, links, source, name, color_mode="RGB", color_depth="8"):
    node = nodes.new("CompositorNodeOutputFile")
    node.base_path = str(OUT)
    node.file_slots[0].path = name
    node.format.file_format = "PNG"
    node.format.color_mode = color_mode
    node.format.color_depth = color_depth
    links.new(source, node.inputs[0])


OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(BLEND))
scene = bpy.context.scene
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.image_settings.color_mode = "RGB"
scene.view_settings.look = "AgX - Medium High Contrast"

layer = scene.view_layers[0]
layer.use_pass_z = True
layer.use_pass_normal = True
bpy.context.view_layer.update()

scene.use_nodes = True
tree = scene.node_tree
tree.nodes.clear()
render = tree.nodes.new("CompositorNodeRLayers")
render.layer = layer.name

file_output(tree.nodes, tree.links, render.outputs["Image"], "beauty-")

# Camera-space normals are encoded from [-1, 1] to [0, 1].
normal_scale = tree.nodes.new("CompositorNodeMixRGB")
normal_scale.blend_type = "MULTIPLY"
normal_scale.inputs[2].default_value = (0.5, 0.5, 0.5, 1)
tree.links.new(render.outputs["Normal"], normal_scale.inputs[1])
normal_bias = tree.nodes.new("CompositorNodeMixRGB")
normal_bias.blend_type = "ADD"
normal_bias.inputs[2].default_value = (0.5, 0.5, 0.5, 1)
tree.links.new(normal_scale.outputs[0], normal_bias.inputs[1])
file_output(tree.nodes, tree.links, normal_bias.outputs[0], "normal-")

# The fixed camera sees useful geometry between roughly 5 and 14 metres.
depth_map = tree.nodes.new("CompositorNodeMapRange")
depth_map.inputs[1].default_value = 5.0
depth_map.inputs[2].default_value = 14.0
depth_map.inputs[3].default_value = 1.0
depth_map.inputs[4].default_value = 0.0
depth_map.use_clamp = True
tree.links.new(render.outputs["Depth"], depth_map.inputs[0])
file_output(tree.nodes, tree.links, depth_map.outputs[0], "depth-", "BW", "16")

bpy.ops.render.render()

# Binary masks are rendered separately with an unlit white override. This is
# more portable than the object-index pass, which is not exposed by every
# Blender render engine on Apple Silicon.
scene.use_nodes = False
mask_material = bpy.data.materials.new("AI guide mask")
mask_material.use_nodes = True
mask_nodes = mask_material.node_tree.nodes
mask_nodes.clear()
mask_output = mask_nodes.new("ShaderNodeOutputMaterial")
mask_emission = mask_nodes.new("ShaderNodeEmission")
mask_emission.inputs["Color"].default_value = (1, 1, 1, 1)
mask_material.node_tree.links.new(mask_emission.outputs[0], mask_output.inputs[0])
layer.material_override = mask_material
scene.world.color = (0, 0, 0)
original_visibility = {obj.name: obj.hide_render for obj in scene.objects}

def render_mask(filename: str, predicate):
    for obj in scene.objects:
        obj.hide_render = obj.type == "MESH" and not predicate(obj)
    scene.render.filepath = str(OUT / filename)
    bpy.ops.render.render(write_still=True)

render_mask("wall-mask.png", lambda obj: obj.name == "Display wall")
render_mask("structure-mask.png", lambda obj: obj.name != "Display wall")
for obj in scene.objects:
    obj.hide_render = original_visibility[obj.name]

def resolve(prefix: str) -> str:
    matches = sorted(OUT.glob(f"{prefix}*.png"))
    return matches[-1].name if matches else ""

metadata = json.loads((ROOM / "scene.json").read_text())
(OUT / "manifest.json").write_text(json.dumps({
    "roomId": ROOM_ID,
    "camera": metadata["camera"],
    "keyLight": metadata["keyLight"],
    "framePosition": metadata["framePosition"],
    "wallZ": metadata["wallZ"],
    "files": {
        "beauty": resolve("beauty-"),
        "depth": resolve("depth-"),
        "normal": resolve("normal-"),
        "wallMask": "wall-mask.png",
        "structureMask": "structure-mask.png",
    },
}, indent=2))
print(f"AI_ROOM_GUIDES {OUT}", flush=True)
