"""Build the fixed portrait room used by the floor-leaning sales view.

Run with Blender --background --factory-startup --python generate_leaning.py.
Coordinates in scene.json are Three.js (Y up); ``xyz`` maps them to Blender.
The plate deliberately contains no artwork or frame because those stay live.
"""
import bpy
import json
import math
import random
import shutil
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/assets/rooms/leaning-floor-gallery"
CONFIG = json.loads((OUT / "scene.json").read_text())
random.seed(1209)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def xyz(point):
    return (point[0], -point[2], point[1])


def linear(hex_colour):
    rgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c < .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb) + (1,)


def material(name, colour, roughness, grain=None, bump=.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = linear(colour)
    bsdf.inputs["Roughness"].default_value = roughness
    if grain:
        coords = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = grain
        noise = nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 3.2
        noise.inputs["Detail"].default_value = 4.5
        noise.inputs["Roughness"].default_value = .72
        ramp = nodes.new("ShaderNodeValToRGB")
        base = linear(colour)
        ramp.color_ramp.elements[0].position = .24
        ramp.color_ramp.elements[0].color = tuple(c * .82 for c in base[:3]) + (1,)
        ramp.color_ramp.elements[1].position = .78
        ramp.color_ramp.elements[1].color = tuple(min(1, c * 1.12) for c in base[:3]) + (1,)
        links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
        links.new(noise.outputs["Fac"], ramp.inputs[0])
        links.new(ramp.outputs[0], bsdf.inputs["Base Color"])
        if bump:
            bump_node = nodes.new("ShaderNodeBump")
            bump_node.inputs["Strength"].default_value = bump
            bump_node.inputs["Distance"].default_value = .0015
            links.new(noise.outputs["Fac"], bump_node.inputs["Height"])
            links.new(bump_node.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def cube(name, position, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(position))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        modifier = obj.modifiers.new("Soft edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    return obj


plaster = material("Fine warm gallery plaster", CONFIG["wallColour"], .94, (46, 46, 46), .055)
skirting = material("Warm white satin skirting", "#ddd7cf", .72)

# A deep wall and floor guarantee that the exported product can cast real
# Cycles shadows. The camera never sees the unfinished outer shell.
cube("Display wall", [0, .4, -.12], [10, 7.4, .24], plaster)
cube("Skirting rear", [0, CONFIG["floorY"] + .12, .075], [10, .24, .15], skirting, .01)

# Individual boards provide real seams, bevel highlights and varied colour.
floor_y = CONFIG["floorY"] - .055
board_depth = .72
for row in range(13):
    colour = random.choice(["#b68b62", "#c2966a", "#a97e58", "#caa276", "#b28761"])
    oak = material(f"Natural oak {row:02d}", colour, .56, (48.0, 2.0, 4.0), .16)
    z = .35 + row * board_depth
    cube("Long oak floorboard", [0, floor_y, z], [10.5, .105, board_depth - .012], oak, .005)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.image_settings.file_format = "JPEG"
scene.render.image_settings.quality = 95
scene.render.resolution_x = CONFIG["imageWidth"]
scene.render.resolution_y = CONFIG["imageHeight"]
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = -.18
scene.world.use_nodes = True
background = scene.world.node_tree.nodes.get("Background")
background.inputs["Color"].default_value = (.82, .86, .92, 1)
background.inputs["Strength"].default_value = .19

light = CONFIG["keyLight"]
bpy.ops.object.light_add(type="AREA", location=xyz(light["position"]))
lamp = bpy.context.object
lamp.name = "Large softbox daylight from right"
lamp.data.energy = light["powerWatts"]
lamp.data.shape = "RECTANGLE"
lamp.data.size = light["width"]
lamp.data.size_y = light["height"]
lamp.data.color = linear(light["color"])[:3]
lamp.rotation_euler = (Vector(xyz(light["target"])) - lamp.location).to_track_quat("-Z", "Y").to_euler()

# A weak frontal card keeps the white wall clean while retaining the broad
# directional shadow that gives a floor-standing frame its depth.
bpy.ops.object.light_add(type="AREA", location=xyz([-2.8, 1.5, 5.5]))
fill = bpy.context.object
fill.name = "Neutral camera fill"
fill.data.energy = 240
fill.data.shape = "DISK"
fill.data.size = 5.0
fill.data.color = linear("#e9f0f7")[:3]
fill.rotation_euler = (Vector(xyz([0, -.3, .4])) - fill.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add(location=xyz(CONFIG["camera"]["position"]))
camera = bpy.context.object
camera.name = "Approved portrait sales camera"
camera.rotation_euler = (Vector(xyz(CONFIG["camera"]["target"])) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.sensor_fit = "VERTICAL"
camera.data.lens = camera.data.sensor_height / (2 * math.tan(math.radians(CONFIG["camera"]["fov"]) / 2))
scene.camera = camera

bpy.context.view_layer.update()
landmarks = []
for point in [[0, -1.0, 0], [-1, CONFIG["floorY"], .25], [1, .4, 0], [-2, -1.6, 0]]:
    projected = world_to_camera_view(scene, camera, Vector(xyz(point)))
    landmarks.append({"world": point, "image": [projected.x, 1 - projected.y]})
(OUT / "projection.json").write_text(json.dumps({"landmarks": landmarks}, indent=2) + "\n")

for image in bpy.data.images:
    if image.source == "FILE":
        image.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "tools/room-template-generator/leaning-floor-gallery.blend"))
scene.render.filepath = str(OUT / "room.jpg")
bpy.ops.render.render(write_still=True)
shutil.copy2(OUT / "room.jpg", OUT / "room-empty.jpg")

# Capture the same room at the product position for interactive reflections.
camera.location = xyz([0, -.85, .32])
camera.rotation_euler = (math.pi / 2, 0, 0)
camera.data.type = "PANO"
camera.data.panorama_type = "EQUIRECTANGULAR"
scene.render.resolution_x = 1024
scene.render.resolution_y = 512
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "16"
scene.render.filepath = str(OUT / "environment.exr")
bpy.ops.render.render(write_still=True)
print("ROOM_TEMPLATE_COMPLETE", OUT, flush=True)
