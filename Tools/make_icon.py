"""Generates Nerdfader's icon: three mixing-desk faders over a synthwave sky.

Usage:  python3 Tools/make_icon.py extension/icons                 writes icon-16/32/48/128.png
        python3 Tools/make_icon.py --png docs/nerdfader-icon.png 1024   one PNG at any size (the README uses 1024)
Needs:  pip install pillow numpy
"""
import sys,os
import numpy as np
from PIL import Image,ImageDraw,ImageFilter

def render(N):
    SS=4; M=N*SS
    I=lambda v:int(round(v*M))
    y=np.mgrid[0:M,0:M][0].astype(np.float32)/M
    t=np.clip(y,0,1)[...,None]
    sky=np.array([24,10,58],np.float32)*(1-t)+np.array([150,30,120],np.float32)*t
    img=Image.fromarray(np.clip(sky,0,255).astype(np.uint8)).convert("RGBA")
    # rounded square
    mask=Image.new("L",(M,M),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,M-1,M-1],radius=I(0.22),fill=255)
    small=N<=32
    # faders: track, glow, knob. Fewer details at toolbar sizes so they stay crisp.
    xs=[0.27,0.5,0.73]; levels=[0.62,0.30,0.48]
    top,bot=0.16,0.84
    g=Image.new("RGBA",(M,M),(0,0,0,0)); gd=ImageDraw.Draw(g)
    tw=0.07 if small else 0.045
    for x,lv in zip(xs,levels):
        gd.rounded_rectangle([I(x-tw/2),I(top),I(x+tw/2),I(bot)],radius=I(tw/2),fill=(94,230,255,255))
    img=Image.alpha_composite(img,g.filter(ImageFilter.GaussianBlur(M*0.02)))
    img=Image.alpha_composite(img,g)
    k=Image.new("RGBA",(M,M),(0,0,0,0)); kd=ImageDraw.Draw(k)
    kw,kh=(0.2,0.13) if small else (0.17,0.09)
    for i,(x,lv) in enumerate(zip(xs,levels)):
        c=(255,79,168,255) if i!=1 else (255,200,87,255)
        kd.rounded_rectangle([I(x-kw/2),I(lv-kh/2),I(x+kw/2),I(lv+kh/2)],radius=I(0.03),fill=c)
        if not small: kd.line([(I(x-kw/2+0.02),I(lv)),(I(x+kw/2-0.02),I(lv))],fill=(30,10,50,255),width=max(1,I(0.012)))
    img=Image.alpha_composite(img,k.filter(ImageFilter.GaussianBlur(M*0.025)))
    img=Image.alpha_composite(img,k)
    out=Image.new("RGBA",(M,M),(0,0,0,0)); out.paste(img,(0,0),mask)
    return out.resize((N,N),Image.LANCZOS)

if len(sys.argv)>2 and sys.argv[1]=="--png":
    render(int(sys.argv[3]) if len(sys.argv)>3 else 1024).save(sys.argv[2])
else:
    d=sys.argv[1] if len(sys.argv)>1 else "extension/icons"; os.makedirs(d,exist_ok=True)
    for n in (16,32,48,128): render(n).save(os.path.join(d,f"icon-{n}.png"))
