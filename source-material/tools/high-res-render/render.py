"""Render an embedded GLB product inside an approved, fixed-camera room."""
import bpy, sys, json, struct
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from colour import combine_passes
ROOT = Path(__file__).resolve().parents[2]
JOB = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
settings = json.loads((JOB / 'settings.json').read_text())
room = settings['roomId']
assert room in ('generated-gallery', 'sofa-gallery')
blend = 'daylight-gallery.blend' if room == 'generated-gallery' else 'sofa-gallery.blend'
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'tools/room-template-generator' / blend))
scene = bpy.context.scene
print('RENDER_PROGRESS 8 Importing your frame and artwork', flush=True)
bpy.ops.import_scene.gltf(filepath=str(JOB / 'frame.glb'))
# Blender's importer does not implement Three's height-map extension. Restore
# its embedded textures and UV transforms, so moulding grain survives export.
glb = (JOB / 'frame.glb').read_bytes()
json_length = struct.unpack_from('<I', glb, 12)[0]
model = json.loads(glb[20:20 + json_length])
binary = glb[28 + json_length:]
for material in model.get('materials', []):
    bump = material.get('extensions', {}).get('EXT_materials_bump')
    mat = bpy.data.materials.get(material.get('name', ''))
    if not bump or not mat: continue
    info = bump['bumpTexture']; texture = model['textures'][info['index']]
    image_info = model['images'][texture['source']]
    view = model['bufferViews'][image_info['bufferView']]
    offset = view.get('byteOffset', 0)
    file = JOB / ('bump-' + str(texture['source']) + '.png')
    file.write_bytes(binary[offset:offset + view['byteLength']])
    image_bump = bpy.data.images.load(str(file), check_existing=True)
    image_bump.colorspace_settings.name = 'Non-Color'
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    tex = nodes.new('ShaderNodeTexImage'); tex.image = image_bump
    uv = nodes.new('ShaderNodeTexCoord'); mapping = nodes.new('ShaderNodeMapping')
    transform = info.get('extensions', {}).get('KHR_texture_transform', {})
    scale = transform.get('scale', [1, 1]); shift = transform.get('offset', [0, 0])
    mapping.inputs['Scale'].default_value = (scale[0], scale[1], 1)
    mapping.inputs['Location'].default_value = (shift[0], shift[1], 0)
    mapping.inputs['Rotation'].default_value[2] = transform.get('rotation', 0)
    links.new(uv.outputs['UV'], mapping.inputs['Vector']); links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
    node = nodes.new('ShaderNodeBump'); node.inputs['Distance'].default_value = abs(bump.get('bumpFactor', .001))
    node.invert = bump.get('bumpFactor', .001) < 0
    links.new(tex.outputs['Color'], node.inputs['Height'])
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf: links.new(node.outputs['Normal'], bsdf.inputs['Normal'])
    image_bump.pack()
    file.unlink()
art = next(o for o in scene.objects if o.name.startswith('product-artwork'))
glass = next((o for o in scene.objects if o.name.startswith('product-glass')), None)
scene.render.resolution_percentage = 100
ratio = scene.render.resolution_x / scene.render.resolution_y
long_edge = 320 if "--smoke-test" in sys.argv else 3200
scene.render.resolution_x = long_edge if ratio >= 1 else round(long_edge * ratio)
scene.render.resolution_y = round(long_edge / ratio) if ratio >= 1 else long_edge
scene.cycles.samples = 8 if "--smoke-test" in sys.argv else 128
scene.cycles.use_denoising = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
source = settings['artworkColourMode'] == 'Source colours'
original_art = art.active_material.copy()

def emission_material(name, colour=(0, 0, 0, 1), image=None):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links; nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial'); emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = colour
    links.new(emit.outputs[0], output.inputs['Surface'])
    if image:
        tex = nodes.new('ShaderNodeTexImage'); tex.image = image
        links.new(tex.outputs['Color'], emit.inputs['Color'])
    return mat

image = next((n.image for n in original_art.node_tree.nodes if n.type == 'TEX_IMAGE'), None)
if source:
    art.active_material = emission_material('Artwork contribution receiver')
else:
    # GLB may carry KHR_materials_unlit; explicitly use a physical print here.
    mat = bpy.data.materials.new('Room-lit fine art print'); mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF'); bsdf.inputs['Roughness'].default_value = .95
    if image:
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = image
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    art.active_material = mat

# Thin glazing: transparent transmission plus restrained reflective contribution.
opacity = .008 if settings['glass'] == 'Museum' else .035
if glass:
    mat = bpy.data.materials.new('Optical glazing'); mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links; nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial'); mix = nodes.new('ShaderNodeMixShader'); mix.inputs[0].default_value = opacity
    transparent = nodes.new('ShaderNodeBsdfTransparent'); glossy = nodes.new('ShaderNodeBsdfGlossy'); glossy.inputs['Roughness'].default_value = .045
    links.new(transparent.outputs[0], mix.inputs[1]); links.new(glossy.outputs[0], mix.inputs[2]); links.new(mix.outputs[0], out.inputs['Surface'])
    glass.active_material = mat
print('RENDER_PROGRESS 18 Rendering soft light, materials and shadows', flush=True)
scene.render.filepath = str(JOB / ('beauty.png' if source else 'final.png'))
bpy.ops.render.render(write_still=True)
if source:
    print('RENDER_PROGRESS 65 Preserving artwork source colours', flush=True)
    holdout = bpy.data.materials.new('Camera holdout'); holdout.use_nodes = True
    nodes = holdout.node_tree.nodes; nodes.clear(); out = nodes.new('ShaderNodeOutputMaterial'); h = nodes.new('ShaderNodeHoldout'); holdout.node_tree.links.new(h.outputs[0], out.inputs['Surface'])
    for obj in scene.objects:
        if obj.type == 'MESH' and obj not in (art, glass):
            for i in range(len(obj.data.materials)): obj.data.materials[i] = holdout
    art.active_material = emission_material('Colour-faithful artwork', image=image)
    if glass:
        nodes = glass.active_material.node_tree.nodes; links = glass.active_material.node_tree.links
        mix = next(n for n in nodes if n.type == 'MIX_SHADER'); h = nodes.new('ShaderNodeHoldout'); links.new(h.outputs[0], mix.inputs[2])
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'; scene.view_settings.exposure = 0; scene.view_settings.gamma = 1
    scene.cycles.samples = 32
    scene.render.filepath = str(JOB / 'source.png'); bpy.ops.render.render(write_still=True)
    print('RENDER_PROGRESS 92 Finishing the high-resolution PNG', flush=True)
    def pixels(file):
        img = bpy.data.images.load(str(JOB / file), check_existing=False)
        data = np.empty(len(img.pixels), dtype=np.float32); img.pixels.foreach_get(data)
        return data.reshape((-1, 4))
    beauty = combine_passes(pixels('beauty.png'), pixels('source.png'))
    final = bpy.data.images.new('Finished image', width=scene.render.resolution_x, height=scene.render.resolution_y, alpha=True, float_buffer=True)
    final.pixels.foreach_set(beauty.ravel()); final.save_render(str(JOB / 'final.png'), scene=scene)
print('RENDER_PROGRESS 100 Your image is ready', flush=True)
