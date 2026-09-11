"""Original room asset: run with Blender --background --python generate.py.

Coordinates in scene.json are Three.js (Y up). Blender receives (x, -z, y).
The room is deliberately empty above the console: product geometry stays live.
No external models, images, or texture licences are needed.
"""
import bpy
import json
import math
import random
from bpy_extras.object_utils import world_to_camera_view
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/rooms/generated-gallery'
CONFIG = json.loads((OUT / 'scene.json').read_text())
random.seed(43)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def xyz(p):
    return (p[0], -p[2], p[1])

def linear(hex_colour):
    rgb = [int(hex_colour[i:i+2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c < .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb) + (1,)

def material(name, colour, roughness=.65, grain=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = linear(colour)
    bsdf.inputs['Roughness'].default_value = roughness
    if grain:
        coords = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeVectorMath')
        mapping.operation = 'MULTIPLY'
        mapping.inputs[1].default_value = grain
        links.new(coords.outputs['Generated'], mapping.inputs[0])
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 5
        noise.inputs['Detail'].default_value = 3
        links.new(mapping.outputs[0], noise.inputs['Vector'])
        ramp = nodes.new('ShaderNodeValToRGB')
        base = linear(colour)
        ramp.color_ramp.elements[0].position = .2
        subtle = name == 'Warm mineral plaster'
        ramp.color_ramp.elements[0].color = tuple(c * (.97 if subtle else .65) for c in base[:3]) + (1,)
        ramp.color_ramp.elements[1].position = .8
        ramp.color_ramp.elements[1].color = tuple(min(1, c * (1.025 if subtle else 1.16)) for c in base[:3]) + (1,)
        links.new(noise.outputs['Fac'], ramp.inputs[0])
        links.new(ramp.outputs[0], bsdf.inputs['Base Color'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .07 if subtle else .16
        bump.inputs['Distance'].default_value = .001 if subtle else .006
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs[0], bsdf.inputs['Normal'])
    return mat

plaster = material('Warm mineral plaster', CONFIG['wallColour'], .89, (35, 35, 35))
trim = material('Limewashed trim', '#d4caba', .72)
walnut = material('Oiled walnut', '#765239', .36, (2, 32, 8))
linen = material('Natural woven linen', '#c4b8a1', .98, (80, 80, 80))
ceramic = material('Ivory ceramic', '#d8cbb1', .29, (8, 8, 8))
dark = material('Charcoal steel', '#272823', .42)
paper = material('Book pages', '#c3b89f', .86)
book = material('Clay book cover', '#7b5040', .8)

def cube(name, pos, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(pos))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Soft manufactured edges', 'BEVEL')
        mod.width, mod.segments = bevel, 3
        obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    return obj

cube('Display wall', [0, .8, -.12], [12, 8, .24], plaster)
cube('Right wall', [5.3, .8, 3], [.24, 8, 6], plaster)
cube('Ceiling', [0, 4.8, 3], [11, .2, 6], plaster)
cube('Left rear pier', [-5.3, .8, .55], [.24, 8, 1.1], plaster)
cube('Left window sill wall', [-5.3, -2.4, 3], [.24, 1.2, 4], plaster)
cube('Left window header', [-5.3, 4, 3], [.24, 1.6, 4], plaster)
cube('Skirting rear', [0, -2.84, .028], [10.6, .32, .07], trim, .012)
cube('Skirting right', [5.14, -2.84, 3], [.07, .32, 6], trim, .012)
for z in (1.1, 3.1, 5.1):
    cube('Window vertical timber', [-5.27, .6, z], [.16, 4.6, .065], trim, .008)
cube('Window horizontal timber', [-5.27, .6, 3.1], [.16, .065, 4.1], trim, .008)

for row in range(21):
    for col in range(4):
        shade = random.choice(['#997b56', '#aa8d64', '#a4865e', '#b09670'])
        mat = material('Oak plank', shade, .52, (2, 55, 6))
        cube('Individual oak floorboard', [-5.0 + row * .51, -3.055, col * 2.2 - (row % 2) * 1.1], [.503, .1, 2.19], mat, .006)

# Floating walnut console, with a continuous shadow gap and softened corners.
cube('Console body', [.15, -1.98, .51], [3.95, .59, .83], walnut, .035)
cube('Console top', [.15, -1.66, .53], [4.08, .065, .89], walnut, .016)
for x in (-1.25, 1.55):
    cube('Console leg', [x, -2.6, .49], [.09, .8, .09], dark, .013)
for x in (-.52, .81):
    cube('Drawer reveal', [x, -1.98, .934], [.012, .49, .007], dark)

def lathe(name, pos, profile, mat):
    verts, faces, count = [], [], 64
    for height, radius in profile:
        for n in range(count):
            a = n * math.tau / count
            verts.append((radius * math.cos(a), radius * math.sin(a), height))
    for j in range(len(profile)-1):
        for n in range(count):
            a = j*count+n
            b = j*count+(n+1)%count
            faces.append((a, b, b+count, a+count))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = xyz(pos)
    obj.data.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = True
    return obj

lathe('Stoneware vase', [-1.22, -1.62, .52], [(0, .12), (.04, .17), (.22, .23), (.45, .2), (.6, .085), (.66, .08), (.67, .06), (.60, .06), (.15, .14), (.03, 0)], ceramic)
for i in range(3):
    cube('Art book', [.91 + i*.035, -1.60 + i*.045, .51], [.72-i*.04, .04, .44], book if i == 2 else paper, .003)
lathe('Small bowl', [.34, -1.61, .47], [(0,.10), (.04,.14), (.12,.22), (.13,.21), (.07,.13), (.035,0)], ceramic)

# A linen bench in the lower right grounds scale without competing with the art.
cube('Bench upholstered seat', [3.5, -2.15, 1.7], [1.75, .34, 1.02], linen, .14)
for x in (2.87, 4.13):
    for z in (1.35, 2.05):
        cube('Bench walnut leg', [x, -2.63, z], [.105, .74, .105], walnut, .016)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 8
scene.world.use_nodes = True
scene.world.node_tree.nodes.get('Background').inputs[0].default_value = (.72, .8, 1, 1)
scene.world.node_tree.nodes.get('Background').inputs[1].default_value = .22

light = CONFIG['keyLight']
bpy.ops.object.light_add(type='AREA', location=xyz(light['position']))
lamp = bpy.context.object
lamp.name = 'Large daylight window — exported key light'
lamp.data.energy = light['powerWatts']
lamp.data.shape = 'RECTANGLE'
lamp.data.size, lamp.data.size_y = light['width'], light['height']
lamp.data.color = linear(light['color'])[:3]
lamp.rotation_euler = (Vector(xyz(light['target'])) - lamp.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=xyz(CONFIG['camera']['position']))
camera = bpy.context.object
camera.name = 'Approved fixed sales camera'
camera.rotation_euler = (Vector(xyz(CONFIG['camera']['target'])) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.sensor_fit = 'VERTICAL'
camera.data.lens = camera.data.sensor_height / (2 * math.tan(math.radians(CONFIG['camera']['fov']) / 2))
scene.camera = camera
scene.render.resolution_x = CONFIG['imageWidth']
scene.render.resolution_y = CONFIG['imageHeight']
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality = 94
scene.render.filepath = str(OUT / 'room.jpg')
bpy.context.view_layer.update()
landmarks = []
for point in [[0, .65, 0], [-1, -.35, 0], [1, 1.65, 0], [-2, -1, 0]]:
    projected = world_to_camera_view(scene, camera, Vector(xyz(point)))
    landmarks.append({'world': point, 'image': [projected.x, 1-projected.y]})
(OUT / 'projection.json').write_text(json.dumps({'landmarks': landmarks}, indent=2) + '\n')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'tools/room-template-generator/daylight-gallery.blend'))
bpy.ops.render.render(write_still=True)

# Capture the actual room from the product location for live reflections/fill.
camera.location = xyz([0, .65, .12])
camera.rotation_euler = (math.pi / 2, 0, 0)
camera.data.type = 'PANO'
camera.data.panorama_type = 'EQUIRECTANGULAR'
scene.render.resolution_x, scene.render.resolution_y = 1024, 512
scene.cycles.samples = 32
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '16'
scene.render.filepath = str(OUT / 'environment.exr')
bpy.ops.render.render(write_still=True)
scene.render.image_settings.file_format = 'JPEG'
bpy.data.images['Render Result'].save_render(str(ROOT / 'tools/room-template-generator/environment-preview.jpg'), scene=scene)
print('ROOM_TEMPLATE_COMPLETE', OUT)
