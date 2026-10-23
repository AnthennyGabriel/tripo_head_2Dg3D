"""Renders GNM's mean bald head as the 2x2 head template sheet.

The head sheet edit copies camera angles, framing and scale from it.

Development-time only; the server just reads the PNG. Run from the repository
root inside the GNM container:

  docker compose run --rm -e PYTHONPATH=/workspace gnm \
      python apps/tripo_head/scripts/render_head_template.py

The panel layout must match SHEET_LAYOUT in src/prompts.js.
"""

import cv2
import numpy as np
import pyrender
import trimesh

from tools.head_retarget.fit_identity import gnm_landmark_model, load_default_gnm

PANEL = 1024
gnm = load_default_gnm()
vertices = np.asarray(gnm.template_vertex_positions, dtype=np.float64)
landmarks = np.asarray(gnm_landmark_model(gnm)[0])
triangles = np.asarray(gnm.triangles_group('~eye_exteriors'))
chin_y = landmarks[8, 1]
# Head and neck only, cut straight across a little below the chin; the image
# model copies a ragged cut edge.
cut_y = chin_y - 0.075
keep = (vertices[triangles, 1] > cut_y).any(axis=1)
mesh = trimesh.Trimesh(vertices.copy(), triangles[keep], process=False)
mesh.remove_unreferenced_vertices()
mesh.vertices[:, 1] = np.maximum(mesh.vertices[:, 1], cut_y)
center = np.array([0.0, (mesh.vertices[:, 1].max() + cut_y) / 2, landmarks[:, 2].mean() - 0.04])
center[0] = landmarks[27:36, 0].mean()
half_extent = 0.5 * (mesh.vertices[:, 1].max() - cut_y) * 1.25

# iBUG point 0 is on the character's right.
right = np.sign(landmarks[0, 0] - center[0])
directions = {
    'front': np.array([0.0, 0.0, 1.0]),
    'back': np.array([0.0, 0.0, -1.0]),
    'left': np.array([-right, 0.0, 0.0]),
    'right': np.array([right, 0.0, 0.0]),
}
layout = ['front', 'back', 'left', 'right']
material = pyrender.MetallicRoughnessMaterial(baseColorFactor=[0.82, 0.74, 0.68, 1.0], metallicFactor=0.0, roughnessFactor=0.7)
renderer = pyrender.OffscreenRenderer(PANEL, PANEL)
sheet = np.full((2 * PANEL, 2 * PANEL, 3), 255, np.uint8)
for panel, view in enumerate(layout):
  scene = pyrender.Scene(bg_color=[1.0, 1.0, 1.0, 1.0], ambient_light=[0.35, 0.35, 0.35])
  scene.add(pyrender.Mesh.from_trimesh(mesh, material=material, smooth=True))
  z = directions[view]
  x = np.cross([0.0, 1.0, 0.0], z)
  x /= np.linalg.norm(x)
  pose = np.eye(4)
  pose[:3, :3] = np.column_stack([x, np.cross(z, x), z])
  pose[:3, 3] = center + z * 1.0
  scene.add(pyrender.OrthographicCamera(xmag=half_extent, ymag=half_extent), pose=pose)
  light = pose.copy()
  light[:3, :3] = light[:3, :3] @ trimesh.transformations.euler_matrix(0.35, 0.3, 0)[:3, :3]
  scene.add(pyrender.DirectionalLight(intensity=3.0), pose=light)
  color, _ = renderer.render(scene)
  row, col = divmod(panel, 2)
  sheet[row * PANEL:(row + 1) * PANEL, col * PANEL:(col + 1) * PANEL] = color
cv2.imwrite('/workspace/apps/tripo_head/assets/head_template.png', cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))
print('rendered', sheet.shape)
