#!/usr/bin/env python3
# ===== process.py =====
# معالجة الفيديو بـ MoviePy — Ken Burns + Fade + Color Grading

import sys
import json
from moviepy import *
import moviepy.video.fx as vfx

def process_section(input_path, output_path, media_type, duration, on_screen_text):
    """
    يعالج section واحد ويضيف التأثيرات الاحترافية
    """
    
    if media_type == 'image':
        # Ken Burns Effect — الصورة تتحرك ببطء
        clip = ImageClip(input_path, duration=duration)
        
        # zoom in تدريجي من 100% إلى 110%
        def zoom_effect(t):
            zoom = 1 + 0.1 * (t / duration)
            return zoom
        
        clip = clip.resize(lambda t: zoom_effect(t))
        clip = clip.set_position('center')
        
    else:
        # فيديو عادي
        clip = VideoFileClip(input_path)
        if clip.duration < duration:
            # تكرار الفيديو إذا كان أقصر من الصوت
            from moviepy import concatenate_videoclips
loops = int(duration / clip.duration) + 1
clip = concatenate_videoclips([clip] * loops).subclipped(0, duration)
        else:
            clip = clip.subclip(0, duration)
    
    # Color Grading — تحسين الألوان
    clip = clip.fx(vfx.colorx, 1.1)  # رفع التشبع قليلاً
    clip = clip.fx(vfx.lum_contrast, lum=5, contrast=0.1)  # رفع السطوع والتباين
    
    # Fade in/out
    clip = clip.fadein(0.5).fadeout(0.5)
    
    # Lower Third — نص أسفل الشاشة
    if on_screen_text:
        txt = TextClip(
            on_screen_text,
            fontsize=28,
            color='white',
            font='DejaVu-Sans-Bold',
            bg_color='rgba(0,0,0,0.6)',
            size=(clip.w, None),
            method='caption'
        )
        txt = txt.set_position(('center', clip.h - txt.h - 30))
        txt = txt.set_duration(min(4, duration))
        txt = txt.fadein(0.5).fadeout(0.5)
        clip = CompositeVideoClip([clip, txt])
    
    # حفظ النتيجة
    clip.write_videofile(
        output_path,
        fps=30,
        codec='libx264',
        audio=False,  # الصوت يُضاف لاحقاً بـ FFmpeg
        preset='ultrafast',
        verbose=False,
        logger=None
    )
    
    clip.close()
    return output_path

if __name__ == '__main__':
    # استقبال المعطيات من command line
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    media_type = sys.argv[3]   # video أو image
    duration = float(sys.argv[4])
    on_screen_text = sys.argv[5] if len(sys.argv) > 5 else ''
    
    process_section(input_path, output_path, media_type, duration, on_screen_text)
    print(f"Done: {output_path}")
