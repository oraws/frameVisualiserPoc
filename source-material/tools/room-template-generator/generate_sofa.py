"""Build the second template from the retained room shell, never overwrite it."""
import bpy, math, json, random
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'public/assets/rooms/sofa-gallery'
C=json.loads((OUT/'scene.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'tools/room-template-generator/daylight-gallery.blend'))
random.seed(18)
def xyz(p): return (p[0],-p[2],p[1])
for ob in list(bpy.data.objects):
    if any(ob.name.startswith(n) for n in ['Console','Drawer','Stoneware','Art book','Small bowl','Bench']):
        bpy.data.objects.remove(ob,do_unlink=True)
def colour(s):
    return tuple(((int(s[i:i+2],16)/255+.055)/1.055)**2.4 for i in (1,3,5))+(1,)
def fabric(name,hex):
    m=bpy.data.materials.new(name);m.use_nodes=True
    n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
    p.inputs['Base Color'].default_value=colour(hex);p.inputs['Roughness'].default_value=.88
    p.inputs['Sheen Weight'].default_value=.24;p.inputs['Sheen Roughness'].default_value=.7
    coord=n.new('ShaderNodeTexCoord');mapping=n.new('ShaderNodeVectorMath');mapping.operation='MULTIPLY';mapping.inputs[1].default_value=(5,5,5)
    l.new(coord.outputs['UV'],mapping.inputs[0]);tex=n.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(ROOT/'tools/room-template-generator/materials/rough_linen_normal.jpg'),check_existing=True);tex.image.colorspace_settings.name='Non-Color'
    l.new(mapping.outputs[0],tex.inputs[0]);normal=n.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.32
    l.new(tex.outputs['Color'],normal.inputs['Color']);l.new(normal.outputs[0],p.inputs['Normal']);return m
linen=fabric('Cream woven upholstery','#c8bba4');pillow=fabric('Ivory cushion linen','#d9ceb9');taupe=fabric('Natural flax cushion','#ac987c')
walnut=bpy.data.materials['Oiled walnut']
def cushion(name,pos,scale,mat,rotation=(0,0,0),wrinkle=.012):
    # Subdivided rounded box with low-amplitude, edge-weighted cloth gathers.
    bpy.ops.mesh.primitive_cube_add(size=2,location=xyz(pos));o=bpy.context.object;o.name=name
    o.scale=(scale[0]/2,scale[2]/2,scale[1]/2);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bevel=o.modifiers.new('Padded corners','BEVEL');bevel.width=min(scale)*.35;bevel.segments=5
    bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=bevel.name)
    sub=o.modifiers.new('Fabric surface','SUBSURF');sub.levels=3;bpy.ops.object.modifier_apply(modifier=sub.name)
    for v in o.data.vertices:
        x,y,z=v.co
        edge=max(abs(x)/(scale[0]/2),abs(z)/(scale[1]/2))
        v.co.y += wrinkle*(math.sin(x*39+z*7)*math.sin(z*17)+.5*math.sin(z*51+x*9))*max(0,edge-.45)
    o.rotation_euler=rotation;o.data.materials.append(mat)
    for f in o.data.polygons:f.use_smooth=True
    return o
def box(name,pos,size,mat):
    bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(pos));o=bpy.context.object;o.name=name;o.dimensions=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat)
    b=o.modifiers.new('Edges','BEVEL');b.width=.025;b.segments=3;o.modifiers.new('Normals','WEIGHTED_NORMAL');return o
box('Sofa timber plinth',[-.2,-2.63,1.25],[5.4,.24,1.82],walnut)
cushion('Sofa upholstered base',[-.2,-2.38,1.25],[5.6,.45,1.92],linen)
cushion('Sofa back',[-.2,-1.73,.38],[5.58,1.55,.47],linen)
for x in [-2.94,2.54]: cushion('Rounded sofa arm',[x,-1.96,1.2],[.42,1.34,1.95],linen)
for x in [-1.52,1.12]:
    cushion('Seat cushion',[x,-2.06,1.35],[2.59,.36,1.53],pillow,wrinkle=.006)
    cushion('Back cushion',[x,-1.37,.69],[2.56,1.06,.3],linen,rotation=(-.15,0,0))
for i,(x,z,angle) in enumerate([(-2.0,.95,-.13),(-.94,1.05,.17),(1.94,.93,.2)]):
    cushion('Loose linen cushion',[x,-1.42,z],[.91,.94,.30],pillow if i!=1 else taupe,rotation=(-.22,angle,.05),wrinkle=.022)
cushion('Lumbar cushion',[.56,-1.71,1.1],[1.13,.5,.3],taupe,rotation=(-.18,.03,0),wrinkle=.016)
# A curtain made as real folded cloth geometry; the outer edge breaks the room silhouette.
verts=[];faces=[];nx=100;ny=30
for j in range(ny+1):
    y=-2.96+j*(7.6/ny)
    for i in range(nx+1):
        x=-4.5+i*1.12/nx;z=.65+.14*math.sin(i/nx*math.pi*12)+.02*math.sin(j*.35+i*.2)
        verts.append(xyz([x,y,z]))
for j in range(ny):
    for i in range(nx):
        a=j*(nx+1)+i;faces.append((a,a+1,a+nx+2,a+nx+1))
mesh=bpy.data.meshes.new('Curtain cloth');mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new('Soft linen curtain',mesh);bpy.context.collection.objects.link(o);o.data.materials.append(pillow)
for p in mesh.polygons:p.use_smooth=True
o.modifiers.new('Cloth thickness','SOLIDIFY').thickness=.008
scene=bpy.context.scene;camera=scene.camera;camera.location=xyz(C['camera']['position']);camera.rotation_euler=(Vector(xyz(C['camera']['target']))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.lens=camera.data.sensor_height/(2*math.tan(math.radians(C['camera']['fov'])/2))
scene.render.resolution_x=C['imageWidth'];scene.render.resolution_y=C['imageHeight'];scene.cycles.samples=96;scene.render.filepath=str(OUT/'room.jpg');scene.render.image_settings.file_format='JPEG'
bpy.context.view_layer.update()
landmarks=[]
for pt in [[0,.8,0],[-1,-.2,0],[1,1.8,0],[-2,-1,0]]:
    p=world_to_camera_view(scene,camera,Vector(xyz(pt)));landmarks.append({'world':pt,'image':[p.x,1-p.y]})
(OUT/'projection.json').write_text(json.dumps({'landmarks':landmarks},indent=2))
for image in bpy.data.images:
    if image.source=='FILE': image.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'tools/room-template-generator/sofa-gallery.blend'))
bpy.ops.render.render(write_still=True)
camera.location=xyz([0,.8,.12]);camera.rotation_euler=(math.pi/2,0,0);camera.data.type='PANO';camera.data.panorama_type='EQUIRECTANGULAR';scene.render.resolution_x=1024;scene.render.resolution_y=512;scene.cycles.samples=32;scene.render.image_settings.file_format='OPEN_EXR';scene.render.image_settings.color_depth='16';scene.render.filepath=str(OUT/'environment.exr');bpy.ops.render.render(write_still=True)
