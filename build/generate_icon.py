from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
RADIUS = int(SIZE * 0.22)  # macOS Big Sur style large radius

# Colors
PAPER = (245, 241, 232)       # Warm paper background
INK_BLUE = (58, 80, 107)      # Dark blue-grey (黛蓝)
GOLD_ACCENT = (201, 168, 108) # Copper gold

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded rectangle background
x0, y0 = 0, 0
x1, y1 = SIZE - 1, SIZE - 1

# Draw rounded rect manually for smooth corners
corner = Image.new('RGBA', (RADIUS, RADIUS), (0, 0, 0, 0))
corner_draw = ImageDraw.Draw(corner)
corner_draw.ellipse((0, 0, RADIUS*2, RADIUS*2), fill=PAPER)

img.paste(corner, (x0, y0))  # top-left
corner_tl = corner
corner_tr = corner.rotate(90, expand=True)
corner_br = corner.rotate(180, expand=True)
corner_bl = corner.rotate(270, expand=True)

img.paste(corner_tr, (x1 - RADIUS + 1, y0))
img.paste(corner_br, (x1 - RADIUS + 1, y1 - RADIUS + 1))
img.paste(corner_bl, (x0, y1 - RADIUS + 1))

# Fill center rectangles
draw.rectangle([x0 + RADIUS//2, y0, x1 - RADIUS//2, y1], fill=PAPER)
draw.rectangle([x0, y0 + RADIUS//2, x1, y1 - RADIUS//2], fill=PAPER)

# Draw open book icon
cx, cy = SIZE // 2, SIZE // 2
book_w = int(SIZE * 0.45)
book_h = int(SIZE * 0.38)
page_gap = 6

# Book cover / outer shape
left_x = cx - book_w // 2
right_x = cx + book_w // 2
top_y = cy - book_h // 2
bot_y = cy + book_h // 2
spine_x = cx

# Left page
draw.polygon([
    (left_x, top_y + 20),
    (spine_x - page_gap, top_y),
    (spine_x - page_gap, bot_y),
    (left_x, bot_y - 20)
], fill=INK_BLUE)

# Right page
draw.polygon([
    (spine_x + page_gap, top_y),
    (right_x, top_y + 20),
    (right_x, bot_y - 20),
    (spine_x + page_gap, bot_y)
], fill=INK_BLUE)

# Spine shadow
draw.rectangle([spine_x - page_gap, top_y, spine_x + page_gap, bot_y], fill=(40, 60, 85))

# Gold accent dot (铜金点缀)
dot_r = 14
draw.ellipse([cx - dot_r, bot_y + 35 - dot_r, cx + dot_r, bot_y + 35 + dot_r], fill=GOLD_ACCENT)

# Save PNG
out_path = os.path.join(os.path.dirname(__file__), 'icon.png')
img.save(out_path, 'PNG')
print(f"Saved icon: {out_path} ({SIZE}x{SIZE})")
