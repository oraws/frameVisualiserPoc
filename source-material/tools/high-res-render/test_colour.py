"""Run with Blender --background --factory-startup --python this-file."""
import bpy, sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from colour import combine_passes
scene=bpy.context.scene
scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.view_settings.exposure=0;scene.view_settings.gamma=1
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
with tempfile.TemporaryDirectory() as folder:
    def roundtrip(name, pixels):
        img=bpy.data.images.new(name,width=1,height=1,float_buffer=True,alpha=True)
        img.pixels[:]=pixels
        path=str(Path(folder)/(name+'.png'));img.save_render(path,scene=scene)
        loaded=bpy.data.images.load(path)
        return np.array(loaded.pixels[:]).reshape((1,4))
    original=np.array([[.02,.2,.5,1]])
    beauty=roundtrip('beauty',original.ravel())
    empty=roundtrip('empty',[0,0,0,0])
    result=roundtrip('output',combine_passes(beauty,empty).ravel())
    assert np.max(np.abs(result-beauty)) < 1.1/255, 'Room colours changed during composition'
    black=roundtrip('black',[0,0,0,1])
    source=roundtrip('source',[.4,.1,.2,1])
    result=roundtrip('artwork',combine_passes(black,source).ravel())
    assert np.max(np.abs(result-source)) < 1.1/255, 'Artwork source colours changed'
print('PNG round-trip preserves room and artwork colours within one 8-bit code value.')
