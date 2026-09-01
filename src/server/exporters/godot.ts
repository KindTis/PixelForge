import type { SpriteDocument } from "../../core/types.ts";
import { buildCommon, type ExportFile, type SheetOptions } from "./common.ts";

function quote(value: string): string {
  return JSON.stringify(value);
}

export async function exportGodot(document: SpriteDocument, options: SheetOptions): Promise<ExportFile[]> {
  const common = buildCommon(document, options);
  const resourceId = new Map(common.metadata.frames.map((frame, index) => [frame.filename, `AtlasTexture_${String(index).padStart(3, "0")}`]));

  const subResources = common.metadata.frames.map((frame) => [
    `[sub_resource type="AtlasTexture" id="${resourceId.get(frame.filename)}"]`,
    'atlas = ExtResource("1_texture")',
    `region = Rect2(${frame.frame.x}, ${frame.frame.y}, ${frame.frame.w}, ${frame.frame.h})`,
    `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${frame.sourceSize.w - frame.spriteSourceSize.w}, ${frame.sourceSize.h - frame.spriteSourceSize.h})`,
  ].join("\n")).join("\n\n");
  const animations = common.metadata.animations.map((animation) => {
    const frames = animation.steps.map((step) => {
      return `{
"duration": ${step.duration / 1000},
"texture": SubResource("${resourceId.get(step.sprite)}")
}`;
    }).join(", ");
    return `{
"frames": [${frames}],
"loop": true,
"name": &${quote(animation.name)},
"speed": 1.0
}`;
  }).join(", ");
  const tres = `[gd_resource type="SpriteFrames" load_steps=${common.metadata.frames.length + 2} format=3]

[ext_resource type="Texture2D" path="spritesheet.png" id="1_texture"]

${subResources}

[resource]
animations = [${animations}]
`;

  return [
    { path: "spritesheet.png", data: common.png },
    { path: "spritesheet.json", data: `${JSON.stringify(common.metadata, null, 2)}\n` },
    { path: "sprite_frames.tres", data: tres },
    { path: "README.md", data: "# Godot 4 가져오기\n\n이 폴더를 Godot 프로젝트에 복사한 뒤 `sprite_frames.tres`를 AnimatedSprite2D의 Sprite Frames로 지정하세요.\n" },
  ];
}
