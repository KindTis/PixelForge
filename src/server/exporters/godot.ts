import { frameSequence } from "../../core/animation.ts";
import type { AnimationTag, SpriteDocument } from "../../core/types.ts";
import { buildCommon, exportCommon, type ExportFile, type SheetOptions } from "./common.ts";

function quote(value: string): string {
  return JSON.stringify(value);
}

export async function exportGodot(document: SpriteDocument, options: SheetOptions): Promise<ExportFile[]> {
  const common = buildCommon(document, options);
  const resourceId = new Map(document.frames.map((frame, index) => [frame.id, `AtlasTexture_${String(index).padStart(3, "0")}`]));
  const tags: AnimationTag[] = document.tags.length ? document.tags : [{
    id: "default",
    name: "default",
    fromFrameId: document.frames[0].id,
    toFrameId: document.frames.at(-1)!.id,
    direction: "forward",
  }];

  const subResources = common.metadata.frames.map((frame, index) => [
    `[sub_resource type="AtlasTexture" id="${resourceId.get(frame.frameId)}"]`,
    'atlas = ExtResource("1_texture")',
    `region = Rect2(${frame.frame.x}, ${frame.frame.y}, ${frame.frame.w}, ${frame.frame.h})`,
    `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${frame.sourceSize.w - frame.spriteSourceSize.w}, ${frame.sourceSize.h - frame.spriteSourceSize.h})`,
  ].join("\n")).join("\n\n");
  const animations = tags.map((tag) => {
    const frames = frameSequence(tag, document.frames).map((frameId) => {
      const frame = document.frames.find((candidate) => candidate.id === frameId)!;
      return `{
"duration": ${frame.durationMs / 1000},
"texture": SubResource("${resourceId.get(frameId)}")
}`;
    }).join(", ");
    return `{
"frames": [${frames}],
"loop": true,
"name": &${quote(tag.name)},
"speed": 1.0
}`;
  }).join(", ");
  const tres = `[gd_resource type="SpriteFrames" load_steps=${document.frames.length + 2} format=3]

[ext_resource type="Texture2D" path="spritesheet.png" id="1_texture"]

${subResources}

[resource]
animations = [${animations}]
`;

  return [
    ...await exportCommon(document, options),
    { path: "sprite_frames.tres", data: tres },
    { path: "README.md", data: "# Godot 4 가져오기\n\n이 폴더를 Godot 프로젝트에 복사한 뒤 `sprite_frames.tres`를 AnimatedSprite2D의 Sprite Frames로 지정하세요.\n" },
  ];
}
