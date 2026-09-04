# PixelForge Unity Native 2D 리깅 및 키프레임 애니메이션 세부 명세서

- **문서 상태:** 최종 합의 설계 기준
- **작성일:** 2026-09-04
- **대상 저장소:** `KindTis/PixelForge`
- **기준 브랜치:** `main`
- **기준 커밋:** `7b15052b69bd8a28c8eccdbd2826df6003975c56`
- **주요 대상 플랫폼:** Unity 6.0 이상
- **외부 런타임 의존성:** 없음
- **유료 패키지 의존성:** 없음
- **기존 기능 호환성:** 필수

---

## 1. 문서 목적

이 문서는 PixelForge에 **Unity Native 2D 컷아웃 리깅 및 키프레임 애니메이션 제작 기능**을 추가하기 위한 제품·데이터·아키텍처·알고리즘·Unity 내보내기·검증 요구사항을 정의한다.

이 문서는 단순 아이디어 문서가 아니라 다음 단계의 구현 계획서와 코드 작업이 참조해야 하는 **기준 명세서**다. 별도 구현 계획에서 작업을 분할하더라도 이 문서의 데이터 경계, 호환성 원칙, 출력 계약과 완료 조건을 변경해서는 안 된다. 변경이 필요하면 이 문서를 먼저 개정한다.

---

## 2. 배경과 문제 정의

현재 PixelForge의 애니메이션은 행동별 스프라이트 시트를 중심으로 구성된다. 캐릭터에 `idle`, `walk`, `attack`, `hit`, `death` 같은 행동을 추가할 때마다 전체 프레임 이미지를 새로 생성하고, 캐릭터 외형과 팔레트와 비율이 기존 프레임과 일치하도록 반복 수정해야 한다.

현재 방식의 제작 비용은 대략 다음 항목의 곱으로 증가한다.

```text
제작 비용 ≈ 캐릭터 수 × 행동 수 × 행동별 프레임 수 × 일관성 수정 비용
```

행동별 이미지 생성은 다음 문제를 반복한다.

- 동일 캐릭터임에도 프레임마다 얼굴, 체형, 의상, 상처와 장비가 달라질 수 있다.
- 새로운 행동마다 전체 캐릭터를 다시 생성해야 한다.
- 프레임 수가 늘수록 픽셀 단위 수정 비용이 증가한다.
- 외형을 한 번 수정해도 기존의 모든 행동 시트를 다시 수정해야 한다.
- 다른 캐릭터에 동일한 걷기나 피격 모션을 재사용할 수 없다.
- 생성 품질을 높여도 행동 수에 비례하는 자산 제작 구조 자체는 개선되지 않는다.

신규 시스템은 캐릭터의 **외형 자산**과 **행동 데이터**를 분리한다.

```text
기본 외형 Atlas
+ Rig Definition
+ Skin Binding
+ Motion Clip
= 재생 가능한 2D 캐릭터
```

캐릭터 외형과 리깅은 최초 한 번만 제작한다. 이후 행동을 추가할 때는 이미지 시트가 아니라 본, IK, 슬롯과 이벤트의 키프레임 데이터만 추가한다.

```text
신규 방식의 제작 비용
≈ 캐릭터 기본 외형 제작
+ 최초 리깅
+ 행동별 경량 키프레임 제작
```

---

## 3. 핵심 제품 목표

### 3.1 목표

1. 기존 PixelForge의 픽셀 편집, 스프라이트 프레임 애니메이션, Codex 생성, 프로젝트 저장과 Common/Godot/Unity 내보내기를 유지한다.
2. 머리, 몸통, 왼팔, 오른팔, 왼다리, 오른다리의 기본 외형을 입력받아 하나의 2D 캐릭터 리그를 구성한다.
3. 하나의 캐릭터 외형과 리그에서 여러 Motion Clip을 제작한다.
4. 새로운 행동을 추가할 때 기본 Atlas, 메시와 리그를 다시 만들지 않는다.
5. 팔과 다리 이미지가 상완·전완 또는 허벅지·종아리로 분리되어 있지 않아도 weighted mesh로 관절을 굽힌다.
6. 관절 각도 기반 corrective deformation을 통해 단순 선형 스키닝의 찌그러짐을 완화한다.
7. 제작 중에는 FK와 IK를 모두 사용할 수 있고, Unity 내보내기 시 기본적으로 본 키프레임으로 베이크한다.
8. 동일한 Rig Profile을 사용하는 캐릭터 사이에서 Motion Clip을 공유하거나 리타기팅할 수 있는 구조를 제공한다.
9. Unity에서 유료 또는 제3자 애니메이션 런타임 없이 바로 사용할 수 있는 Native Rig 자산을 생성한다.
10. 대량 캐릭터나 픽셀 완전성이 필요한 경우 동일한 Motion Clip을 기존 Sprite/AnimationClip 방식으로 베이크할 수 있다.

### 3.2 비목표

초기 구현 범위에는 다음을 포함하지 않는다.

- Spine Editor 프로젝트 또는 `spine-unity` 런타임 호환성
- Live2D, DragonBones 등 제3자 런타임 호환성
- 임의의 3D 시점 전환이나 보이지 않는 뒷면 자동 생성
- 단일 측면 이미지로부터의 완전 자동 무인 리깅
- 물리 기반 ragdoll
- Unity DOTS/ECS 전용 런타임
- 수천 개의 Native Rig 캐릭터를 동시에 재생하는 GPU 군중 시스템
- Unity 안에서 PixelForge와 동일한 리깅 편집 기능 제공
- 임의 토폴로지 생물 전체를 지원하는 범용 골격 편집기

초기 지원 대상은 **2D 인간형 측면 캐릭터**다. 데이터 모델은 확장 가능하게 설계하지만 첫 번째 Rig Profile은 `HumanoidSideProfileV1`로 제한한다.

---

## 4. 필수 설계 원칙

### 4.1 외형과 모션의 분리

Motion Clip에는 캐릭터 고유의 텍스처, 정점 위치, UV 또는 vertex corrective를 직접 포함하지 않는다.

```text
Rig Profile
    공통 본 의미와 계층

Character Skin
    캐릭터 고유 Atlas, 메시, 가중치와 기준 포즈

Corrective Profile
    캐릭터 고유 관절 변형 보정

Motion Clip
    재사용 가능한 본·IK·슬롯·이벤트 키프레임
```

이 경계를 지켜야 다음 조합이 가능하다.

```text
ChefZombieSkin  + HumanoidSideProfileV1 + WalkMotion
PoliceZombieSkin + HumanoidSideProfileV1 + WalkMotion
OfficeZombieSkin + HumanoidSideProfileV1 + WalkMotion
```

### 4.2 기존 SpriteDocument와 신규 RiggingAsset의 격리

기존 `SpriteDocument`에 본, 메시와 연속 시간 키프레임을 직접 추가하지 않는다.

```text
SpriteProject
├─ document: SpriteDocument
└─ rigging?: RiggingAsset
```

두 도메인은 다음 어댑터를 통해서만 연결한다.

- Sprite/PNG에서 Rig Part 가져오기
- Rig Motion을 SpriteDocument 애니메이션 세트로 베이크하기
- 기존 Unity Baked Sprite exporter로 전달하기

### 4.3 엔진 중립 Rig Core

`src/core/rig/`는 다음에 의존하지 않는다.

- React
- DOM 또는 Canvas API
- Node.js 파일 시스템
- Unity 타입
- 특정 렌더 파이프라인
- Spine 또는 제3자 런타임

Unity 변환은 서버 exporter와 Unity importer에서만 수행한다.

### 4.4 결정론

같은 프로젝트 데이터와 내보내기 설정은 다음 항목에서 동일한 결과를 만들어야 한다.

- Atlas region 순서
- 메시 정점과 triangle 순서
- bone weight 정규화 결과
- Motion Clip 샘플
- Unity sub-asset 식별자
- 출력 파일명
- source hash

부동소수점 직렬화는 유효 자릿수와 반올림 규칙을 고정한다.

### 4.5 비파괴적 재내보내기

새 Motion Clip을 추가하거나 기존 Motion Clip을 수정할 때 다음 자산의 식별자가 불필요하게 변경되어서는 안 된다.

- Atlas texture
- Mesh sub-asset
- Material sub-asset
- Bone hierarchy path
- Character main object
- 기존 AnimationClip sub-asset

Unity의 Scene, Prefab, Addressables나 다른 자산이 가진 참조가 재내보내기로 끊어지지 않아야 한다.

---

## 5. 용어

| 용어 | 정의 |
| --- | --- |
| **Rig Profile** | 본의 의미, 계층, 기본 슬롯, 제약과 Motion 호환 규칙을 정의하는 공통 규격 |
| **Character Skin** | 특정 캐릭터의 Atlas, 메시, UV, 가중치, 기준 포즈와 슬롯 배치 |
| **Rig Part** | 머리, 몸통, 팔, 다리 또는 추가 attachment에 해당하는 입력 외형 |
| **Bone** | 부모 Transform에 상대적인 위치, 회전과 스케일을 갖는 골격 노드 |
| **Slot** | 특정 attachment를 표시하고 draw order를 갖는 렌더 단위 |
| **Attachment** | Slot에 장착되는 텍스처 region 및 weighted mesh |
| **Skin Binding** | 메시 정점과 Bone 사이의 가중치 관계 |
| **Corrective Profile** | 관절 각도에 따른 캐릭터별 정점 보정 데이터 |
| **Motion Clip** | 본, IK, 슬롯, attachment와 이벤트의 시간 기반 키프레임 |
| **Setup Pose** | 메시 bind pose와 Motion 기준이 되는 캐릭터 기본 자세 |
| **Authoring IK** | PixelForge 편집 중 사용하는 IK. 기본적으로 Unity 본 키로 베이크됨 |
| **Runtime IK** | Unity 게임 실행 중 target을 추적하는 선택적 PixelForge 자체 컴포넌트 |
| **Native Rig Export** | Unity Mesh, SkinnedMeshRenderer, AnimationClip과 자체 importer로 내보내는 방식 |
| **Baked Sprite Export** | 리그의 각 시점을 래스터 프레임으로 렌더링해 기존 Sprite 방식으로 내보내는 방식 |

---

## 6. 사용자 시나리오

### 6.1 최초 캐릭터 제작

1. 사용자가 6개 신체 부위 PNG를 입력한다.
2. 사용자가 기준 포즈에서 부위를 배치한다.
3. 사용자가 목, 어깨, 팔꿈치, 손목, 골반, 무릎과 발목 랜드마크를 지정한다.
4. PixelForge가 본 계층, 메시와 초기 가중치를 만든다.
5. 사용자가 테스트 포즈로 관절 변형을 확인한다.
6. 사용자가 weight와 corrective를 수정한다.
7. 사용자가 `idle`, `walk` 등 Motion Clip을 제작한다.
8. Unity Native Rig로 내보낸다.
9. Unity에서 `.pfrig` 자산을 가져오면 바로 배치 가능한 GameObject 자산과 AnimationClip이 생성된다.

### 6.2 신규 행동 추가

1. 기존 Rig 프로젝트를 연다.
2. 새 Motion Clip을 만든다.
3. FK 또는 IK로 키프레임을 작성한다.
4. 기존 Unity 출력 위치로 다시 내보낸다.
5. Atlas와 Mesh는 동일 식별자를 유지하고 새 AnimationClip만 추가된다.

### 6.3 외형 수정

1. 머리 또는 의상 attachment의 픽셀을 수정한다.
2. 리그 배치와 메시 topology가 유지되는 경우 Atlas만 갱신한다.
3. 모든 기존 Motion Clip에 수정된 외형이 자동 적용된다.
4. 알파 실루엣이 메시 범위를 벗어난 경우만 메시 재생성을 경고한다.

### 6.4 모션 공유

1. 두 Character Skin이 같은 Rig Profile과 호환 버전을 사용한다.
2. 사용자가 공용 Motion Clip을 선택한다.
3. PixelForge가 본 길이와 기준 포즈를 기준으로 translation과 IK target을 리타기팅한다.
4. 각 Character Skin용 Unity AnimationClip을 생성하되 Canonical Motion의 ID를 보존한다.

---

## 7. 상위 시스템 구조

```text
PixelForge App
│
├─ Project Shell
│  ├─ 프로젝트 수명·저장·Undo/Redo
│  ├─ Codex 생성 작업
│  └─ Workspace 선택
│
├─ Sprite Workspace
│  ├─ 기존 EditorWorkspace
│  ├─ 기존 SpriteDocument Core
│  └─ Common / Godot / Unity Baked Export
│
└─ Rig Workspace
   ├─ Part Setup
   ├─ Bone / Slot Setup
   ├─ Mesh / Weight Editing
   ├─ Corrective Editing
   ├─ Motion Authoring
   ├─ Rig Preview
   ├─ Unity Native Rig Export
   └─ Sprite Bake Adapter
```

```text
Unity Project
│
├─ PixelForge Runtime
│  ├─ PixelForgeRigDefinition          ScriptableObject
│  ├─ PixelForgeRigBinding             MonoBehaviour
│  ├─ PixelForgeRigPlayer
│  ├─ PixelForgeTwoBoneIK            선택적
│  ├─ PixelForgeCorrectiveDriver     Runtime IK 사용 시
│  ├─ PixelForgeSlotOrderDriver
│  └─ PixelForgeAttachmentDriver
│
├─ PixelForge Editor
│  └─ PixelForgeRigImporter : ScriptedImporter
│
└─ Imported .pfrig
   ├─ Character GameObject           Main Object
   ├─ Mesh sub-assets
   ├─ Material sub-asset
   ├─ AnimationClip sub-assets
   └─ Rig metadata sub-asset
```

---

## 8. PixelForge 프로젝트 포맷

### 8.1 프로젝트 v2

```ts
export type SpriteProjectV2 = {
  format: "pixelforge-project";
  version: 2;

  id: string;
  name: string;

  // 기존 도메인
  document: SpriteDocument;
  generationHistory: GenerationRecord[];
  exportSettings: ExportSettings;

  // 신규 도메인
  rigging?: RiggingAsset;
};
```

`rigging`은 선택 필드다. 기존 Sprite 전용 프로젝트에는 존재하지 않아도 된다.

### 8.2 v1 마이그레이션

```ts
export function migrateProjectV1ToV2(
  source: SpriteProjectV1,
): SpriteProjectV2 {
  return {
    ...source,
    version: 2,
    rigging: undefined,
  };
}
```

마이그레이션 규칙:

- 기존 `document`, 프레임 ID, 레이어 ID, 셀 ID와 이미지 ID를 변경하지 않는다.
- 기존 generation history와 export settings를 변경하지 않는다.
- v1 파일을 처음 저장하기 전까지 원본 파일을 덮어쓰지 않는다.
- v2 저장은 현재 원자적 저장 방식을 유지한다.
- 지원하지 않는 미래 버전은 명확히 거부한다.

### 8.3 RiggingAsset

```ts
export type RiggingAsset = {
  schemaVersion: 1;
  profile: RigProfile;
  skin: CharacterSkin;
  correctives: CorrectiveProfile;
  motions: MotionClip[];
  settings: RigProjectSettings;
};
```

---

## 9. Rig Profile 명세

### 9.1 타입

```ts
export type RigProfile = {
  id: string;
  version: number;
  name: string;
  kind: "humanoid-side-profile";
  facing: "left" | "right";

  boneDefinitions: RigProfileBone[];
  slotDefinitions: RigProfileSlot[];
  constraintDefinitions: RigProfileConstraint[];

  retarget: RetargetProfile;
};
```

```ts
export type RigProfileBone = {
  semantic:
    | "root"
    | "pelvis"
    | "torsoLower"
    | "torsoUpper"
    | "neck"
    | "head"
    | "upperArmLeft"
    | "forearmLeft"
    | "handLeft"
    | "upperArmRight"
    | "forearmRight"
    | "handRight"
    | "thighLeft"
    | "shinLeft"
    | "footLeft"
    | "thighRight"
    | "shinRight"
    | "footRight";
  parentSemantic?: RigProfileBone["semantic"];
  required: boolean;
};
```

### 9.2 `HumanoidSideProfileV1` 기본 계층

```text
root
└─ pelvis
   ├─ torsoLower
   │  └─ torsoUpper
   │     ├─ neck
   │     │  └─ head
   │     ├─ upperArmLeft
   │     │  └─ forearmLeft
   │     │     └─ handLeft
   │     └─ upperArmRight
   │        └─ forearmRight
   │           └─ handRight
   ├─ thighLeft
   │  └─ shinLeft
   │     └─ footLeft
   └─ thighRight
      └─ shinRight
         └─ footRight
```

입력 이미지가 손과 발을 별도 attachment로 제공하지 않더라도 `hand`와 `foot` Bone은 end effector 및 리타기팅 기준으로 존재한다.

### 9.3 Profile 호환 규칙

Motion Clip의 `profileId`가 대상 Character Skin과 같고 다음 조건을 만족하면 직접 적용할 수 있다.

```text
motion.profileVersion <= target.profileVersion
필수 semantic bone이 모두 존재
호환되지 않는 constraint type이 없음
Motion이 요구하는 slot semantic이 모두 존재
```

호환되지 않을 경우 묵시적으로 일부 track을 버리지 않고 오류 또는 명시적 사용자 승인 대상으로 처리한다.

---

## 10. Character Skin 명세

```ts
export type CharacterSkin = {
  id: string;
  name: string;
  profileId: string;
  profileVersion: number;

  canvas: RigCanvas;
  atlas: RigAtlas;
  parts: Record<string, RigPart>;
  bones: RigBone[];
  slots: RigSlot[];
  attachments: Record<string, RigAttachment>;
  meshes: Record<string, RigMesh>;
  constraints: RigConstraint[];
};
```

```ts
export type RigCanvas = {
  width: number;
  height: number;
  pixelsPerUnit: number;
  origin: { x: number; y: number };
};
```

```ts
export type RigBone = {
  id: string;
  semantic: RigProfileBone["semantic"];
  name: string;
  parentId?: string;

  setup: {
    position: Vec2;
    rotationDeg: number;
    scale: Vec2;
    length: number;
  };

  limits?: {
    minRotationDeg: number;
    maxRotationDeg: number;
    allowTranslation: boolean;
    allowScale: boolean;
  };
};
```

```ts
export type RigSlot = {
  id: string;
  semantic: string;
  name: string;
  boneId: string;
  setupAttachmentId: string;
  setupDrawOrder: number;
  visible: boolean;
  color: RGBA;
};
```

---

## 11. 신체 부위 입력 계약

### 11.1 필수 부위

```ts
export type RequiredBodyPart =
  | "head"
  | "torso"
  | "leftArm"
  | "rightArm"
  | "leftLeg"
  | "rightLeg";
```

각 필수 부위는 정확히 하나 이상의 attachment를 가져야 한다.

### 11.2 선택 attachment

다음은 선택적으로 추가할 수 있다.

- 열린 입 또는 손상된 머리
- 주먹, 펼친 손, 무기 파지 손
- 앞쪽/뒤쪽 팔 변형
- 무기
- 모자, 방패, 가방
- 피격 또는 절단 상태 부위
- 시각 효과 attachment

선택 attachment도 Slot에 연결되며 Motion Clip의 attachment track으로 전환할 수 있다.

### 11.3 PNG 요구사항

- RGBA PNG
- 투명 배경
- 가로와 세로 각각 1~4096 픽셀
- 불투명 또는 반투명 픽셀이 한 개 이상 존재
- 깨진 PNG, 색상 채널 오류와 비정상 크기는 가져오기 전에 거부
- 현재 프로젝트의 인덱스 팔레트 모드를 사용하는 경우 Atlas 생성 시 해당 팔레트로 양자화 가능
- 메타데이터의 논리 크기와 디코딩된 PNG 크기가 일치해야 함

### 11.4 관절 루트 여유 영역

팔과 다리는 관절 연결부가 빈틈 없이 겹칠 수 있도록 다음 영역을 포함해야 한다.

```text
팔: 어깨 연결 영역과 손목 끝
다리: 골반 연결 영역과 발목/발 끝
몸통: 목과 양쪽 고관절 연결 영역
머리: 목 연결 영역
```

관절 루트는 torso 아래에 가려지는 **overlap margin**을 허용한다. Atlas 이미지는 중복 해부 구조를 만들지 않되, 투명 seam을 막기 위한 최소한의 텍스처 중첩은 허용한다.

사용자가 입력 단계에서 연결부가 부족한 경우 다음 중 하나를 수행한다.

1. 원본 이미지를 수정한다.
2. PixelForge의 픽셀 편집기로 root extension을 그린다.
3. 메시만 늘리지 않고 텍스처가 실제로 존재하도록 요구한다.

투명 픽셀만 늘려서 seam을 숨기는 것은 허용하지 않는다.

---

## 12. 좌표계

### 12.1 PixelForge 이미지 좌표

```text
원점: 좌측 상단
+X: 오른쪽
+Y: 아래
단위: 픽셀
```

### 12.2 Rig Core 좌표

```text
원점: Character Skin의 root origin
+X: 오른쪽
+Y: 위
회전 양수: 반시계
단위: design pixel
```

변환:

```ts
rigX = imageX - originX;
rigY = originY - imageY;
```

### 12.3 Unity 좌표

```text
+X: 오른쪽
+Y: 위
+Z: 카메라 방향 축
위치 단위: Unity unit
```

변환:

```ts
unityX = rigX / pixelsPerUnit;
unityY = rigY / pixelsPerUnit;
unityZ = 0;
unityRotationZ = rigRotationDeg;
```

UV 변환:

```ts
u = atlasX / atlasWidth;
v = 1 - atlasY / atlasHeight;
```

draw order는 기본적으로 Z 위치가 아니라 Renderer의 sorting order로 표현한다.

---

## 13. Setup Pose와 랜드마크

### 13.1 필수 랜드마크

```text
머리: neckRoot, headCenter
몸통: pelvisCenter, waistCenter, chestCenter, neckRoot
왼팔: shoulderLeft, elbowLeft, wristLeft
오른팔: shoulderRight, elbowRight, wristRight
왼다리: hipLeft, kneeLeft, ankleLeft
오른다리: hipRight, kneeRight, ankleRight
```

### 13.2 배치 데이터

각 Rig Part는 다음 Setup Transform을 갖는다.

```ts
export type RigPartTransform = {
  position: Vec2;
  rotationDeg: number;
  scale: Vec2;
  flipX: boolean;
  flipY: boolean;
};
```

### 13.3 자동 생성 결과

랜드마크를 확정하면 PixelForge가 다음을 만든다.

- Bone 위치와 길이
- 부모·자식 계층
- Slot과 기본 draw order
- Part별 메시
- UV
- 초기 bone weight
- 팔과 다리의 2-bone IK constraint
- 관절 corrective sample의 초기 빈 상태 또는 자동 초안

자동 결과는 확정값이 아니라 사용자가 수정할 수 있는 시작점이다.

---

## 14. 메시 생성

### 14.1 공통 조건

```ts
export type RigMesh = {
  id: string;
  attachmentId: string;

  vertices: Vec2[];
  uvs: Vec2[];
  triangles: number[];

  weights: VertexWeight[][];
  bounds: Rect;

  topologyRevision: number;
};
```

검증 규칙:

- 정점 수와 UV 수가 같아야 한다.
- triangle index는 정점 범위 안에 있어야 한다.
- triangle index 수는 3의 배수여야 한다.
- 면적이 0인 triangle은 허용하지 않는다.
- winding은 Unity 변환 후 카메라를 향하도록 일관되어야 한다.
- 모든 정점은 한 개 이상의 Bone 영향을 받아야 한다.
- 가중치 합은 허용 오차 `1e-5` 이내에서 1이어야 한다.
- topologyRevision이 바뀌면 기존 corrective delta의 호환성을 재검증한다.

### 14.2 팔과 다리: 리본 메시

팔과 다리는 중심선 기반 리본 메시를 기본으로 한다.

```text
Shoulder/Hip ─ Joint ─ Wrist/Ankle
```

생성 절차:

1. 세 랜드마크를 통과하는 중심 polyline을 만든다.
2. 중심선을 길이 기준으로 샘플링한다.
3. 각 샘플에서 접선과 수직 벡터를 계산한다.
4. 알파 마스크에서 양쪽 실루엣까지의 거리를 찾는다.
5. 좌우 정점을 만든다.
6. 관절 전후에 support cross-section을 추가한다.
7. 인접 cross-section을 고정된 대각선 규칙으로 삼각형화한다.
8. 각 정점의 setup 위치에서 Atlas UV를 계산한다.

관절 부근의 기본 cross-section 밀도는 다른 구간보다 높아야 한다. 세부 수치는 part 크기와 영향 반경을 기준으로 자동 결정하며 사용자가 subdivision을 조절할 수 있다.

### 14.3 몸통: Spine-aligned cage

몸통은 `pelvis → waist → chest → neck` 축에 맞춘 2D cage mesh를 사용한다.

- 각 spine landmark 높이에 수평 cross-section 생성
- 어깨와 고관절 부근에 추가 support row 생성
- 좌우 외곽은 torso 알파 경계 또는 사용자가 지정한 cage 폭으로 결정
- `pelvis`, `torsoLower`, `torsoUpper`, `neck`에 가중치 분배

### 14.4 머리: 저밀도 lattice

머리는 기본적으로 neck과 head 두 Bone에 영향을 받는 저밀도 lattice를 사용한다.

- 머리가 rigid attachment로 충분하면 head 가중치 1로 축소 가능
- 턱이나 머리 흔들림 보정이 필요하면 lattice subdivision 증가
- 입 모양처럼 구조가 크게 변하는 변화는 mesh deform보다 attachment 교체를 우선

### 14.5 투명 영역

메시가 투명 bounding region을 일부 포함하는 것은 허용한다. 텍스처 알파가 0인 픽셀은 렌더되지 않으므로 topology 안정성을 위해 불필요하게 복잡한 contour triangulation을 강제하지 않는다.

단, 메시가 part의 불투명 영역을 포함하지 못하는 경우 오류다.

---

## 15. Bone Weight

```ts
export type VertexWeight = {
  boneId: string;
  weight: number;
};
```

### 15.1 영향 수 제한

```text
팔·다리: 정점당 최대 2 Bone
머리:    정점당 최대 2 Bone
몸통:    정점당 최대 3 Bone
```

### 15.2 초기 가중치

사지 중심선 상에서 관절 위치를 `jointS`, 정점의 투영 위치를 `vertexS`, 영향 반경을 `r`이라고 한다.

```ts
distal = smoothstep(jointS - r, jointS + r, vertexS);
proximal = 1 - distal;
```

관절과 멀리 떨어진 정점은 단일 Bone 가중치 1을 사용한다.

### 15.3 정규화

1. 음수, NaN과 무한대 가중치를 거부한다.
2. `minWeight`보다 작은 값을 제거한다.
3. 영향 수 상한을 넘으면 큰 가중치만 남긴다.
4. 남은 가중치 합으로 정규화한다.
5. 모든 가중치가 제거되면 가장 가까운 Bone에 1을 부여한다.

### 15.4 수동 도구

- Add
- Subtract
- Replace
- Smooth
- Normalize
- Prune
- Flood
- Bone influence lock
- 정점·브러시 영역 선택
- Heatmap 표시

weight 편집은 한 pointer drag를 하나의 Undo transaction으로 기록한다.

---

## 16. 관절 Corrective Deformation

### 16.1 목적

Linear Blend Skinning만으로 관절을 크게 굽히면 다음 문제가 생긴다.

- 관절 안쪽이 지나치게 납작해짐
- 관절 바깥쪽이 과도하게 늘어남
- 픽셀 실루엣이 꺾임
- 팔꿈치와 무릎의 두께가 사라짐

Corrective Profile은 캐릭터별 메시를 기준으로 이 문제를 보정한다.

### 16.2 데이터

```ts
export type CorrectiveProfile = {
  schemaVersion: 1;
  joints: Record<string, JointCorrective>;
};
```

```ts
export type JointCorrective = {
  id: string;
  jointBoneId: string;
  referenceBoneId: string;
  axis: "z";
  influenceVertexIds: number[];
  samples: JointCorrectiveSample[];
};
```

```ts
export type JointCorrectiveSample = {
  id: string;
  angleDeg: number;
  deltaVertices: Vec2[];
};
```

### 16.3 평가

1. parent와 child Bone 사이의 현재 상대 각도를 계산한다.
2. 회전 wrap을 제거해 연속 각도를 얻는다.
3. 현재 각도를 둘러싼 corrective sample을 찾는다.
4. 두 sample의 vertex delta를 선형 보간한다.
5. 스키닝된 정점에 corrective delta를 더한다.

`0°` sample은 모든 delta가 0이어야 한다.

### 16.4 자동 초안

PixelForge는 관절 중심선을 원호로 굽히는 Arc Bend 초안을 제공할 수 있다.

- 관절 안쪽 압축
- 바깥쪽 신장
- 중심선 길이 유지
- cross-section 두께 보존
- 영향 반경 밖 delta 0

자동 결과는 수동 sculpt로 수정 가능해야 한다.

### 16.5 Unity 변환

Unity Native Rig에서는 corrective sample을 `Mesh.AddBlendShapeFrame`으로 변환한다.

- Blend Shape 이름은 안정적인 ID를 사용한다.
- 예: `PF_CORR_<joint-id>_<sample-id>`
- 작성된 Motion Clip은 관절 각도를 평가하여 Blend Shape weight curve를 생성한다.
- Runtime IK를 사용하지 않으면 별도 corrective runtime 계산이 필요 없다.
- Runtime IK를 사용하면 `PixelForgeCorrectiveDriver`가 `LateUpdate`에서 weight를 계산한다.

---

## 17. Constraint와 IK

### 17.1 타입

```ts
export type RigConstraint =
  | TwoBoneIkConstraint
  | RotationLimitConstraint;
```

```ts
export type TwoBoneIkConstraint = {
  id: string;
  type: "twoBoneIk";

  parentBoneId: string;
  childBoneId: string;
  endBoneId: string;

  target: Vec2;
  bendDirection: 1 | -1;
  mix: number;
  softness: number;
  minReachRatio: number;
  maxReachRatio: number;
};
```

### 17.2 Authoring IK

PixelForge의 기본 IK는 analytic 2-bone solver다.

처리 순서:

```text
Setup Pose
→ FK transform keys
→ IK target 및 mix
→ 2-bone solve
→ Bone local rotation 계산
→ Skinning
→ Corrective
```

Solver 요구사항:

- 도달 범위 밖 target clamp
- 접힌 상태의 수치 불안정 방지
- bendDirection 유지
- softness에 의한 최대 도달 거리 부근 완화
- `mix=0`이면 FK 결과와 동일
- `mix=1`이면 IK 결과 사용
- 중간 mix는 FK/IK 회전을 shortest-path로 보간

### 17.3 Unity 기본 출력

Authoring IK track은 Unity 내보내기 시 다음으로 변환한다.

```text
IK target key
→ PixelForge pose evaluator
→ parent/child Bone local rotation
→ Unity AnimationClip rotation curve
```

따라서 일반적인 애니메이션 재생에는 Unity runtime IK가 필요하지 않다.

### 17.4 선택적 Runtime IK

게임 실행 중 무기 조준, 발 위치 보정이나 target 추적이 필요한 경우에만 다음 자체 컴포넌트를 사용한다.

```csharp
PixelForgeTwoBoneIK
```

필수 실행 순서:

```text
Animator/Playable evaluation
→ PixelForgeTwoBoneIK.LateUpdate
→ PixelForgeCorrectiveDriver.LateUpdate
→ Render
```

Runtime IK는 Native Rig export 옵션으로 선택하며 기본값은 비활성화다.

---

## 18. Motion Clip

### 18.1 타입

```ts
export type MotionClip = {
  id: string;
  name: string;

  profileId: string;
  profileVersion: number;

  durationMs: number;
  loop: boolean;

  tracks: MotionTrack[];
  events: MotionEvent[];

  retargetSettings: MotionRetargetSettings;
};
```

```ts
export type MotionTrack =
  | BoneTransformTrack
  | IkTargetTrack
  | ConstraintMixTrack
  | SlotOrderTrack
  | AttachmentTrack
  | VisibilityTrack
  | ColorTrack;
```

### 18.2 키프레임

```ts
export type Keyframe<T> = {
  id: string;
  timeMs: number;
  value: T;
  interpolation:
    | { type: "stepped" }
    | { type: "linear" }
    | {
        type: "bezier";
        inTangent: Vec2;
        outTangent: Vec2;
      };
};
```

공통 규칙:

- `timeMs`는 0 이상 `durationMs` 이하다.
- 같은 track에 같은 시간의 키를 두 개 허용하지 않는다.
- key ID는 순서 변경 후에도 유지한다.
- Rotation track은 내보내기 전 angle unwrap을 수행한다.
- Loop Clip은 첫 시점과 마지막 시점의 불연속을 검사한다.
- Stepped attachment와 draw-order key는 값 사이를 보간하지 않는다.

### 18.3 Bone Transform Track

```ts
export type BoneTransformTrack = {
  type: "boneTransform";
  boneSemantic: RigProfileBone["semantic"];

  position?: Keyframe<Vec2>[];
  rotationDeg?: Keyframe<number>[];
  scale?: Keyframe<Vec2>[];
};
```

기본 Motion 재사용성을 위해 다음 원칙을 적용한다.

- 사지 움직임은 가능한 한 rotation 중심으로 작성한다.
- Bone translation은 필요한 Bone에서만 허용한다.
- scale animation은 기본적으로 균일 scale을 우선한다.
- 메시 고유 vertex 위치는 Motion Clip에 저장하지 않는다.

### 18.4 이벤트

```ts
export type MotionEvent = {
  id: string;
  timeMs: number;
  name: string;
  intValue?: number;
  floatValue?: number;
  stringValue?: string;
};
```

예:

```text
footstep_left
footstep_right
attack_hit
spawn_projectile
death_complete
```

Unity 내보내기는 이를 `AnimationEvent` 또는 `PixelForgeRigPlayer` 이벤트 테이블로 변환할 수 있다. 기본값은 문자열 기반 `PixelForgeRigPlayer` 이벤트다.

---

## 19. Motion 재사용과 리타기팅

### 19.1 직접 공유

다음 조건에서는 Motion Clip을 수정 없이 공유한다.

- 동일한 Rig Profile ID와 호환 버전
- 동일한 semantic bone
- 기준 자세 축 방향 일치
- translation track을 사용하지 않거나 같은 비율
- 동일한 필수 Slot semantic

### 19.2 정규화

Motion Clip의 translation과 IK target은 다음 공간 중 하나를 명시한다.

```ts
export type MotionSpace =
  | "localPixels"
  | "parentLengthNormalized"
  | "characterHeightNormalized"
  | "root";
```

권장 기본값:

```text
Bone rotation:             로컬 각도
사지 Bone translation:    사용하지 않음
IK target:                 root 또는 parentLengthNormalized
pelvis vertical movement:  characterHeightNormalized
root motion:               characterHeightNormalized
```

### 19.3 리타기팅

```text
Canonical Motion
→ 대상 Setup Pose와 Bone 길이 로드
→ normalized translation 복원
→ IK target 복원
→ 대상 관절 limit 적용
→ pose evaluation
→ 결과 검증
→ 대상 Unity AnimationClip 생성
```

Limit clamp가 발생하면 내보내기 결과에 경고를 기록한다.

### 19.4 단계별 지원

초기 릴리스의 필수 성공 범위는 **동일 Character Skin에서 여러 Motion Clip을 사용하는 것**이다.

공용 Motion Library와 체형 차이 리타기팅은 데이터 구조를 처음부터 지원하되 구현 단계는 후속 slice로 분리할 수 있다. 그러나 Motion 데이터에 skin-specific vertex data를 섞어 향후 리타기팅을 막는 임시 구현은 허용하지 않는다.

---

## 20. Slot, Attachment와 Draw Order

### 20.1 기본 Slot

```text
head
torso
leftArm
rightArm
leftLeg
rightLeg
```

Slot은 Bone과 Attachment를 연결한다. 여러 Attachment가 같은 Slot을 공유할 수 있다.

### 20.2 Draw Order

Setup Pose는 정수 draw order를 가진다. Motion Clip은 시간에 따라 Slot order를 변경할 수 있다.

예:

```text
공격 시작: 오른팔이 몸통 뒤
타격 순간: 오른팔이 몸통 앞
복귀: 오른팔이 몸통 뒤
```

### 20.3 Attachment 교체

Attachment Track은 stepped key만 허용한다.

```text
open_hand → grip_hand → open_hand
closed_mouth → open_mouth → closed_mouth
normal_head → damaged_head
```

### 20.4 2D 표현 한계 처리

다음 변화는 메시를 극단적으로 찌그러뜨리지 않고 attachment 교체를 우선한다.

- 손바닥 앞면과 뒷면 전환
- 입을 크게 벌림
- 무기 파지 상태
- 몸의 앞뒤를 넘는 팔
- 카메라 방향으로 향하는 사지
- 절단이나 대규모 형태 변화

---

## 21. Rig Workspace UI

### 21.1 Workspace 전환

프로젝트 상단에 다음 전환을 제공한다.

```text
Sprite | Rig
```

`Sprite`는 기존 `EditorWorkspace`를 유지한다. `Rig`는 별도 `RigWorkspace`를 사용한다.

### 21.2 화면 구조

```text
┌────────────────────────────────────────────────────────────┐
│ Setup | Animate        Tool Bar                             │
├──────────────┬─────────────────────────────┬───────────────┤
│ Outliner     │ Viewport                    │ Inspector     │
│ Parts        │ Character / Bone / Mesh     │ Transform     │
│ Bones        │ Weight / IK / Corrective    │ Constraint    │
│ Slots        │                             │ Properties    │
├──────────────┴─────────────────────────────┴───────────────┤
│ Motion List | Dopesheet / Keyframe Timeline               │
└────────────────────────────────────────────────────────────┘
```

### 21.3 Setup 모드 도구

- Part import 및 교체
- Part move, rotate, scale, flip
- Landmark 배치
- Bone 생성·선택·이동
- Slot draw order
- Mesh 생성·정점 편집
- Weight paint
- IK constraint 설정
- Corrective sample 선택·sculpt
- Setup Pose 테스트

### 21.4 Animate 모드 도구

- Motion 생성·복제·삭제·이름 변경
- 재생, 정지, loop
- 시간 커서
- Auto Key
- Bone FK 조작
- IK target 조작
- 키 선택·이동·복제·삭제
- Stepped, Linear, Bezier 보간
- Slot order와 attachment key
- Event key
- 현재 pose reset
- Motion compatibility 상태 표시

### 21.5 선택과 편집 상태

Sprite Workspace의 활성 frame/layer 상태와 Rig Workspace의 활성 bone/slot/motion 상태를 공유하지 않는다. Workspace를 전환해도 각 상태는 별도로 보존한다.

---

## 22. Rig Preview Renderer

### 22.1 구현 경계

기존 `CanvasRenderer`는 SpriteDocument 전용으로 유지한다. Rig preview는 별도 `RigRenderer`를 사용한다.

```text
src/client/rig/RigRenderer.ts
```

### 22.2 렌더 단계

```text
Motion sampling
→ Bone world transform
→ Constraint solve
→ Linear blend skinning
→ Corrective deformation
→ Slot order
→ Atlas sampling
→ Overlay
```

### 22.3 표시 옵션

- Atlas Point filtering
- Grid
- Bone
- Bone name
- Mesh wireframe
- Vertex
- Weight heatmap
- IK target
- Joint influence radius
- Corrective delta
- Bounding box
- Pixel scale preview

### 22.4 픽셀 아트 주의사항

Point filtering은 텍스처 색상 보간을 막지만 임의 회전과 메시 변형으로 인한 화면 픽셀 격자 변화까지 막지는 않는다.

따라서 Native Rig는 다음 특성을 갖는다.

- 연속적이고 부드러운 관절 변형
- 적은 행동별 자산
- 일부 픽셀 형태 변화 허용

완전한 pixel-perfect 프레임이 필요한 경우 Baked Sprite 출력을 사용한다.

---

## 23. Atlas

### 23.1 구조

```ts
export type RigAtlas = {
  width: number;
  height: number;
  padding: number;
  regions: Record<string, RigAtlasRegion>;
};
```

```ts
export type RigAtlasRegion = {
  id: string;
  partId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};
```

### 23.2 패킹 규칙

- 단일 Atlas page
- 최대 8192×8192
- region rotation 없음
- 안정적인 part/attachment ID 순서
- 기본 padding 2px
- 투명 외곽 trim은 초기값 비활성화
- trim을 사용하면 source offset을 명시적으로 저장
- 기존 region이 같은 크기를 유지하면 위치 유지 패킹을 우선
- Atlas 변경은 source hash에 포함

### 23.3 Unity Texture 설정

Unity importer는 Atlas PNG에 다음을 적용한다.

```text
Texture Type: Default
Filter Mode: Point
Compression: None
Generate Mip Maps: Off
Wrap Mode: Clamp
Alpha Is Transparency: On
Aniso Level: 0
Read/Write: Off
```

Native Rig는 Sprite slice를 필요로 하지 않으며 full Atlas texture와 UV를 직접 사용한다.

---

## 24. Unity Native Rig 출력 계약

### 24.1 대상 버전

- 기준 구현 및 자동 통합 테스트: Unity 6.0
- Unity 6.0보다 오래된 버전의 지원은 초기 완료 조건에 포함하지 않는다.
- 사용하는 API가 하위 버전에 존재하더라도 공식 지원 범위는 별도 검증 후 확장한다.

### 24.2 의존성 정책

다음 유료 또는 제3자 의존성은 사용하지 않는다.

- `spine-unity`
- Asset Store 유료 애니메이션 패키지
- 제3자 native DLL
- 제3자 managed DLL

Unity 2D Animation 및 Unity 2D IK 같은 Unity 공식 패키지는 사용자의 프로젝트에 설치되어 있어도 상관없지만, PixelForge Native Rig의 import와 runtime 동작이 이를 필수로 요구해서는 안 된다.

Unity 프로젝트가 이미 URP를 사용한다면 URP는 Unity 공식 렌더 파이프라인으로 허용하지만, Rig 동작 자체는 URP에 의존하지 않는다.

### 24.3 사용하는 Unity 기능

```text
UnityEngine.Mesh
UnityEngine.BoneWeight1
UnityEngine.SkinnedMeshRenderer
UnityEngine.Transform
UnityEngine.AnimationClip
UnityEngine.Animator
UnityEngine.Playables
UnityEngine.Animations
UnityEngine.Material
UnityEngine.Texture2D

UnityEditor.AssetImporters.ScriptedImporter
UnityEditor.AssetImporters.AssetImportContext
UnityEditor.AnimationUtility
UnityEditor.AssetPostprocessor
UnityEditor.TextureImporter
```

Unity 6의 `Mesh.SetBoneWeights`, `BoneWeight1`, `Mesh.AddBlendShapeFrame`, `AnimationUtility.SetEditorCurve`와 Scripted Importer API를 기준으로 한다.

### 24.4 출력 파일

```text
PixelForgeUnity/
├─ PixelForgeIntegration/
│  ├─ Runtime/
│  │  ├─ PixelForgeRigDefinition.cs
│  │  ├─ PixelForgeRigBinding.cs
│  │  ├─ PixelForgeRigPlayer.cs
│  │  ├─ PixelForgeTwoBoneIK.cs
│  │  ├─ PixelForgeCorrectiveDriver.cs
│  │  ├─ PixelForgeSlotOrderDriver.cs
│  │  ├─ PixelForgeAttachmentDriver.cs
│  │  └─ PixelForge.Runtime.asmdef
│  │
│  ├─ Editor/
│  │  ├─ PixelForgeRigImporter.cs
│  │  ├─ PixelForgeRigImporterEditor.cs
│  │  ├─ PixelForgeAtlasPostprocessor.cs
│  │  ├─ PixelForgeUnityMeshBuilder.cs
│  │  ├─ PixelForgeUnityClipBuilder.cs
│  │  └─ PixelForge.Editor.asmdef
│  │
│  └─ Shaders/
│     ├─ PixelForgeUnlitBuiltin.shader
│     └─ PixelForgeUnlitURP.shader       URP 선택 시에만
│
└─ PixelForgeGenerated/
   └─ <project-id>/
      ├─ <character>.pfrig
      └─ <character>.pfatlas.png
```

Unity 프로젝트에는 위 폴더를 `Assets/` 아래에 복사하거나 PixelForge가 직접 설치한다.

---

## 25. `.pfrig` 포맷

### 25.1 목적

`.pfrig`는 JSON 기반의 PixelForge Unity Native Rig source asset이다. Unity `ScriptedImporter`가 이 파일을 읽어 Unity Object를 생성한다.

```ts
export type PixelForgeUnityRigFile = {
  format: "pixelforge-unity-rig";
  version: 1;

  source: {
    projectId: string;
    skinId: string;
    profileId: string;
    profileVersion: number;
    exportRevision: string;
    contentHash: string;
  };

  atlas: UnityRigAtlasRef;
  bones: UnityRigBoneData[];
  slots: UnityRigSlotData[];
  meshes: UnityRigMeshData[];
  correctives: UnityRigCorrectiveData[];
  motions: UnityRigMotionData[];
  settings: UnityRigImportSettings;
};
```

### 25.2 파일명과 식별자

파일명은 사용자가 바꿀 수 있으나 내부 식별자는 UUID를 사용한다.

Unity sub-asset identifier:

```text
main:character
rig-definition:<skin-id>
material:<material-id>
mesh:<attachment-id>
clip:<motion-id>
```

Unity `AssetImportContext.AddObjectToAsset`에 전달하는 identifier는 재import마다 동일하게 생성한다. 배열 index나 표시 이름을 identifier로 사용하지 않는다.

### 25.3 Hash

`contentHash`는 다음 정규화 데이터의 SHA-256이다.

- profile
- skin setup
- meshes
- weights
- correctives
- motions
- import settings
- Atlas region metadata
- Atlas PNG hash

표시 이름 변경만으로 불필요한 메시 topology ID를 바꾸지 않는다.

---

## 26. Unity Scripted Importer

### 26.1 등록

```csharp
[ScriptedImporter(
    version: 1,
    ext: "pfrig",
    AllowCaching = true)]
public sealed class PixelForgeRigImporter : ScriptedImporter
{
    public override void OnImportAsset(AssetImportContext context)
    {
        // validate → load atlas → build assets → register sub-assets
    }
}
```

### 26.2 Atlas 전처리

Atlas PNG는 Unity 기본 Texture importer가 처리한다. `PixelForgeAtlasPostprocessor`는 파일명이 `.pfatlas.png`로 끝나는 texture에만 `OnPreprocessTexture`를 적용한다.

```text
Texture Type: Default
Filter Mode: Point
Compression: None
Generate Mip Maps: Off
Wrap Mode: Clamp
Alpha Is Transparency: On
Aniso Level: 0
Read/Write: Off
```

`PixelForgeRigImporter`가 다른 asset의 `TextureImporter` 설정을 import 도중 직접 변경해서 재귀 import를 일으키지 않도록 책임을 분리한다.

### 26.3 Dependency 선언

`PixelForgeRigImporter`는 `.pfrig`에서 Atlas 경로를 읽어 import 전에 dependency를 선언한다.

```csharp
static string[] GatherDependenciesFromSourceFile(string path)
```

`OnImportAsset`에서도 Atlas의 import artifact에 dependency를 등록한다. Atlas PNG가 변경되면 `.pfrig`가 자동으로 재import되어 Material과 Mesh reference가 최신 Texture를 가리켜야 한다.

### 26.4 Rig Import 순서

1. `.pfrig` JSON 파싱
2. format/version 검증
3. Atlas asset path 결정
4. Atlas texture import 결과에 artifact dependency 등록
5. Bone 및 Slot reference 검증
6. Mesh 생성
7. Bone weight와 bind pose 설정
8. Blend Shape 추가
9. Material 생성
10. Character GameObject 계층 생성
11. SkinnedMeshRenderer 구성
12. AnimationClip 생성
13. Rig metadata 생성
14. Runtime component 연결
15. 모든 Object를 결정론적 identifier로 `AddObjectToAsset`
16. Character GameObject를 Main Object로 설정

### 26.5 재import 안정성

- 같은 identifier는 같은 sub-asset으로 인식되어야 한다.
- 제거된 Motion Clip은 import 결과에서 제거되지만 다른 Motion ID를 재사용하지 않는다.
- 이름 변경은 같은 Motion ID를 유지한다.
- Atlas 경로 변경은 dependency를 갱신한다.
- import 오류 발생 시 불완전한 Main Object를 생성하지 않고 `LogImportError`로 보고한다.

### 26.6 Main Object

Main Object는 Project 창에서 Scene으로 드래그할 수 있는 model-style imported Character GameObject다. 일반 Prefab과 동일하게 Scene에 인스턴스화할 수 있지만 source asset의 import 결과이므로 직접 구조를 수정하는 대신 Prefab Variant를 만드는 사용 방식을 권장한다.

```text
<CharacterName>
├─ Animator
├─ PixelForgeRigPlayer
├─ PixelForgeRigBinding
├─ Bones
│  └─ root
│     └─ pelvis
│        ├─ torsoLower
│        ├─ thighLeft
│        └─ thighRight
└─ Slots
   ├─ head
   ├─ torso
   ├─ leftArm
   ├─ rightArm
   ├─ leftLeg
   └─ rightLeg
```

Importer Inspector는 `Create Prefab Variant` 명령을 제공할 수 있다. 이 명령은 사용자가 선택한 경로에 일반 Prefab Variant를 만들며 자동 import의 필수 단계는 아니다.

---

## 27. Unity Mesh 변환

### 27.1 부위별 Renderer

초기 구현은 Slot 또는 Attachment별 `SkinnedMeshRenderer`를 사용한다.

장점:

- draw order 변경이 단순함
- attachment visibility와 교체가 단순함
- 서로 다른 corrective set을 독립적으로 관리 가능
- 구현과 디버깅 위험이 낮음

단점:

- Slot 수만큼 Renderer와 draw call이 증가함

기본 인간형은 6개 Renderer를 목표로 한다. 대량 캐릭터는 Baked Sprite 경로를 사용한다.

### 27.2 Mesh 구성

```csharp
mesh.SetVertices(vertices);
mesh.SetUVs(0, uvs);
mesh.SetTriangles(triangles, 0);
mesh.bindposes = bindPoses;
mesh.SetBoneWeights(bonesPerVertex, allBoneWeights);
mesh.AddBlendShapeFrame(
    shapeName,
    100.0f,
    deltaVertices,
    null,
    null);
mesh.RecalculateBounds();
```

2D unlit 렌더링이므로 normal과 tangent는 초기 구현에서 생성하지 않아도 된다. 선택한 shader가 요구하는 경우 `(0, 0, -1)` normal과 기본 tangent를 생성한다.

### 27.3 Bind Pose

각 Renderer의 Bone 배열과 bind pose 배열 순서는 동일해야 한다.

```text
bindPose[i] = bone[i].worldToLocalMatrix × rendererRoot.localToWorldMatrix
```

모든 Renderer는 같은 canonical Bone hierarchy를 참조한다.

### 27.4 Root Bone

`SkinnedMeshRenderer.rootBone`은 캐릭터의 `root` Bone으로 설정한다.

---

## 28. Unity AnimationClip 변환

### 28.1 Clip sub-asset

Motion Clip마다 하나의 Unity `AnimationClip` sub-asset을 만든다.

```text
clip:<motion-id>
```

### 28.2 Transform path

Bone path는 semantic 기반 안정 경로를 사용한다.

```text
Bones/root/pelvis/torsoLower/torsoUpper
Bones/root/pelvis/thighLeft/shinLeft
```

표시 이름을 바꾸더라도 semantic path를 변경하지 않는다.

### 28.3 Curve

다음 Unity property에 curve를 기록한다.

```text
m_LocalPosition.x
m_LocalPosition.y
m_LocalPosition.z
m_LocalRotation.x
m_LocalRotation.y
m_LocalRotation.z
m_LocalRotation.w
m_LocalScale.x
m_LocalScale.y
m_LocalScale.z
```

회전은 quaternion curve로 출력하며 key 생성 전에 Z angle을 unwrap한다.

### 28.4 Bezier 변환

PixelForge cubic Bezier 키는 Unity AnimationCurve tangent로 변환한다. 완전한 동일성이 보장되지 않는 curve는 허용 오차 기반 적응 샘플링으로 보존한다.

기본 오차 기준:

```text
위치: 0.05 design pixel
회전: 0.1 degree
scale: 0.001
```

이 값은 exporter 설정으로 조정할 수 있다.

### 28.5 Corrective curve

작성된 Motion Clip에 대해서는 관절 각도를 샘플링하고 다음 property curve를 생성한다.

```text
blendShape.PF_CORR_<joint-id>_<sample-id>
```

### 28.6 Loop

Loop 여부는 `PixelForgeRigDefinition`의 Motion metadata에 저장하고 `PixelForgeRigPlayer`가 Playable 시간을 순환시킨다. 내부 Unity Clip의 비공개 직렬화 필드에 의존하지 않는다. 시작/끝 pose가 허용 오차를 넘으면 export warning을 기록하되 사용자가 명시적으로 허용한 경우 출력은 가능하다.

### 28.7 Clip 재생

기본 Main Object는 `Animator`와 `PixelForgeRigPlayer`를 가진다. `PixelForgeRigPlayer`는 Unity Playables API로 import된 `AnimationClip`을 재생한다.

필수 API:

```csharp
Play(string motionName, bool restart = true)
CrossFade(string motionName, float duration)
Stop()
SetSpeed(float speed)
```

AnimatorController를 필수 생성하지 않는다. 필요 시 후속 exporter 옵션으로 제공할 수 있다.

---

## 29. Unity Runtime 컴포넌트

### 29.1 PixelForgeRigDefinition

`ScriptableObject` sub-asset이다.

역할:

- Motion 이름과 AnimationClip 연결
- Attachment와 Mesh sub-asset 연결
- profile/skin/version 정보
- loop, duration, event metadata
- runtime feature 설정

### 29.2 PixelForgeRigBinding

Main Object의 `MonoBehaviour`다.

역할:

- `PixelForgeRigDefinition` 참조
- Bone semantic과 Transform 연결
- Slot과 Renderer 연결
- Runtime driver 연결

### 29.3 PixelForgeRigPlayer

역할:

- `PlayableGraph` 생성과 해제
- AnimationClip 재생
- loop
- speed
- crossfade
- Motion event 전달
- 동일 캐릭터의 Clip lookup

### 29.4 PixelForgeSlotOrderDriver

역할:

- Slot별 sorting order 적용
- Motion curve가 기록한 정수 채널 평가
- Renderer의 `sortingLayerID`와 `sortingOrder` 갱신

AnimationClip은 Driver의 직렬화된 float 채널을 애니메이션하며 Driver가 정수로 변환한다.

### 29.5 PixelForgeAttachmentDriver

역할:

- Attachment index 키를 평가
- 대상 Renderer의 Mesh, material/texture region 또는 활성 상태 변경
- 같은 Slot에서 교체되는 Mesh는 동일한 Bone 배열 순서와 호환 bind pose를 사용
- stepped transition만 허용

### 29.6 PixelForgeTwoBoneIK

선택 기능이다.

- analytic 2-bone solve
- target Transform
- bend direction
- mix
- softness
- reach clamp
- LateUpdate 실행

### 29.7 PixelForgeCorrectiveDriver

Runtime IK가 활성화된 관절만 처리한다.

- 상대 관절 각도 계산
- corrective sample weight 계산
- `SetBlendShapeWeight` 호출
- 비활성 Motion에서는 0으로 복원

---

## 30. 렌더 파이프라인

### 30.1 Built-in Render Pipeline

기본 지원 대상이다. PixelForge가 제공하는 Unlit Transparent Shader를 사용한다.

필수 상태:

```text
Cull Off
ZWrite Off
Blend SrcAlpha OneMinusSrcAlpha
Lighting Off
Point-filtered Atlas
```

### 30.2 URP

URP 사용자가 내보내기에서 URP를 선택하면 URP 전용 Shader source를 함께 출력한다.

- URP는 Unity 공식 패키지로 허용
- Rig 데이터와 runtime 코드는 Built-in과 동일
- Shader만 교체
- URP package가 없는 프로젝트에서 URP shader를 출력하지 않는다

### 30.3 HDRP

초기 지원 범위에서 제외한다. Native Rig 데이터 자체는 유지되므로 후속 shader adapter로 확장할 수 있다.

---

## 31. Unity 직접 설치

### 31.1 Unity 프로젝트 검증

사용자가 Unity Project root를 선택할 경우 다음을 확인한다.

```text
Assets/
Packages/manifest.json
ProjectSettings/ProjectVersion.txt
```

### 31.2 설치 규칙

- `Assets/PixelForgeIntegration/`에 importer와 runtime source 설치
- integration source에 명시적 `integrationVersion`을 두고 동일하거나 최신 버전이면 불필요하게 덮어쓰지 않음
- `Assets/PixelForgeGenerated/<project-id>/`에 `.pfrig`와 Atlas 설치
- 기존 `.meta` 파일을 삭제하거나 직접 다시 쓰지 않음
- 같은 project ID는 같은 경로를 사용
- file content는 임시 파일 작성 후 같은 경로에 rename
- 더 이상 사용하지 않는 파일은 자동 삭제하지 않고 orphan 목록으로 보고

### 31.3 컴파일 순서

Unity source가 처음 설치되는 경우 C# 컴파일이 먼저 필요하다. PixelForge는 다음 두 단계로 안내하거나 Unity Editor 연동 명령을 제공한다.

```text
1. PixelForgeIntegration source 설치
2. Unity script compile 완료
3. .pfrig 및 Atlas 설치 또는 재import
```

묵시적으로 Unity 프로젝트의 `Packages/manifest.json`을 변경하지 않는다.

---

## 32. Baked Sprite 출력

### 32.1 목적

다음 조건에서는 Native Rig보다 Baked Sprite가 적합하다.

- 수백~수천 일반 몬스터
- 화면 픽셀 격자 보존이 중요한 경우
- 런타임 Bone 평가가 불필요한 경우
- 고정된 카메라와 해상도에서만 사용
- attachment와 실시간 IK가 필요하지 않은 경우

### 32.2 처리

```text
Motion sampling
→ Rig pose
→ CPU triangle rasterization
→ Alpha cleanup
→ 선택적 palette remap
→ SpriteDocument frame 생성
→ 기존 Unity Sprite exporter
```

### 32.3 출력

현재 PixelForge의 Unity Sprite exporter 구조를 유지한다.

```text
spritesheet.png
pixelforge-unity.json
Editor/PixelForgeImporter.cs
AnimationClip
```

UI에서는 다음 두 출력으로 구분한다.

```text
Unity — Native Rig
Unity — Baked Sprite
```

### 32.4 결정론

동일한 Rig, Motion, sample rate와 bake 설정은 동일한 pixel hash를 생성해야 한다.

---

## 33. 저장 구조

```text
projects/<project-id>/
├─ pixelforge.json
├─ cels/
│  └─ <sprite-image-id>.png
└─ rig/
   └─ parts/
      └─ <rig-image-id>.png
```

`pixelforge.json`에는 다음을 저장한다.

- Rig Profile
- Bone/Slot/Constraint
- Part transform
- Atlas region
- Mesh topology
- UV
- Bone weight
- Corrective
- Motion Clip
- Rig export settings

PNG byte는 기존 방식과 같이 별도 파일로 저장한다.

### 33.1 Typed Array 직렬화

Wire와 disk 경계에서 다음을 명시적으로 변환한다.

```text
Uint8ClampedArray ↔ number[]
Float32Array      ↔ number[]
Uint16Array       ↔ number[]
Uint32Array       ↔ number[]
```

로드 시 배열 길이, 정수 범위, NaN, Infinity와 예상 element count를 검증한다.

---

## 34. Undo/Redo

현재 History의 undo field에 `rigging`을 추가한다.

```ts
export type UndoableProjectField =
  | "document"
  | "rigging"
  | "generationHistory"
  | "exportSettings";
```

### 34.1 Transaction

다음 작업은 pointer down부터 pointer up까지 한 transaction이다.

- Bone 이동 또는 회전
- Landmark 이동
- Mesh vertex 이동
- Weight paint
- Corrective sculpt
- Keyframe drag
- 여러 key scale
- IK target drag

### 34.2 대형 데이터 복사

- 변경된 Mesh 또는 Motion만 복사
- 변경되지 않은 typed array는 참조 공유
- preview 중에는 transient state 사용
- pointer up에서 immutable project state로 commit
- autosave는 commit 이후 debounce

---

## 35. 서버 API

기존 프로젝트 CRUD는 프로젝트 v2를 지원하도록 확장한다.

신규 endpoint:

```text
POST /api/projects/:projectId/rig/export
```

요청:

```ts
export type RigExportRequest = {
  target: "unity-native" | "unity-baked";
  output:
    | { kind: "bundle"; directory: string }
    | { kind: "unity-project"; projectRoot: string };
  settings: RigExportSettings;
};
```

응답:

```ts
export type RigExportResponse = {
  status: "completed";
  outputPath: string;
  files: string[];
  warnings: RigExportWarning[];
  sourceHash: string;
};
```

서버는 클라이언트가 보낸 임의 절대 경로를 그대로 사용하지 않고 기존 path containment 및 Windows directory picker 정책을 따른다.

---

## 36. 검증과 오류 처리

### 36.1 Rig 전체 검증

- 필수 6부위 존재
- Bone ID 중복 없음
- parent 참조 유효
- Bone cycle 없음
- profile semantic 중복 없음
- 필수 semantic 존재
- Slot의 Bone과 Attachment 유효
- Mesh topology 유효
- UV 유효
- Bone weight 유효
- Constraint chain 유효
- Corrective topologyRevision 일치
- Motion track target 유효
- key time 유효
- Motion 이름 및 ID 고유
- Atlas bounds 유효

### 36.2 내보내기 전 검증

- Unity target version
- Atlas texture 존재
- PPU 양수
- Shader profile 유효
- 모든 Mesh가 하나 이상의 Slot에서 사용됨
- 모든 Motion의 profile compatibility
- loop seam
- retarget clamp
- sub-asset identifier 충돌
- 출력 경로가 허용 root 안에 있음

### 36.3 오류 수준

```text
Error
    내보내기 또는 저장 중단

Warning
    결과는 생성하지만 품질 또는 호환 위험 보고

Info
    최적화 또는 선택 기능 안내
```

### 36.4 부분 성공 금지

Unity Native Rig bundle은 Atlas, `.pfrig`와 integration source 중 일부만 성공한 상태로 완료 처리하지 않는다. 임시 디렉터리에서 전체 bundle을 생성·검증한 뒤 설치한다.

Unity 프로젝트 직접 설치 시 기존 `.meta`를 보존하기 위해 폴더 전체 교체 대신 파일 단위 원자 갱신을 사용한다.

---

## 37. 성능 및 규모 제한

초기 기본 제한:

```text
Character Skin당 Bone:          최대 64
필수 인간형 Bone 목표:          18 이하
Slot/Renderer 목표:             기본 6
Attachment:                     최대 256
Part별 정점 권장:               32~512
Character 전체 정점 권장:       2048 이하
정점당 Bone influence:          최대 3
Motion Clip:                    최대 256
Motion key:                     프로젝트당 최대 100,000
Atlas:                          최대 8192×8192
```

제한 초과는 저장 데이터 손상을 의미하지 않지만 exporter는 명확한 오류 또는 성능 경고를 제공한다.

Native Rig 동시 사용 수는 프로젝트 환경에 따라 프로파일링한다. PixelForge는 수백~수천 개체에 Native Rig 사용을 기본 권장하지 않으며 Baked Sprite 경로를 제공한다.

---

## 38. 테스트 전략

기존 결과가 저품질이라는 사실을 다시 입증하기 위한 불필요한 비교 생성은 수행하지 않는다. 검증은 신규 기능의 구조적 정확성, 결정론, Unity 호환성과 실제 관절 동작에 집중한다.

### 38.1 TypeScript 단위 테스트

```text
tests/rig-validation.test.ts
tests/rig-hierarchy.test.ts
tests/rig-mesh.test.ts
tests/rig-weights.test.ts
tests/rig-ik.test.ts
tests/rig-corrective.test.ts
tests/rig-animation.test.ts
tests/rig-retarget.test.ts
tests/rig-bake.test.ts
tests/unity-rig-export.test.ts
tests/project-v2-migration.test.ts
```

필수 사례:

- Bone cycle 검출
- invalid reference 검출
- 알려진 2-bone IK 해
- reach clamp
- `mix=0/1`
- weight 합 1
- influence 제한
- 퇴화 triangle 검출
- corrective 0도 항등성
- corrective sample 연속 보간
- angle unwrap
- loop seam 검출
- retarget normalized translation
- 동일 입력의 동일 source hash
- v1 프로젝트 무손실 migration
- Native Rig 추가 후 기존 Sprite test 회귀 없음

### 38.2 Unity EditMode 테스트

별도 fixture Unity 6.0 프로젝트에서 수행한다.

- `.pfrig` Scripted Importer 등록
- Atlas dependency 감지
- Main GameObject 생성
- Bone hierarchy 생성
- Mesh 정점/UV/triangle 일치
- bind pose와 Bone 배열 일치
- BoneWeight1 합 검증
- Blend Shape 생성
- AnimationClip curve 생성
- deterministic sub-asset identifier
- reimport 후 기존 Scene reference 유지
- 삭제/이름 변경 Motion 처리
- 외부 패키지 없이 compile
- Built-in shader compile
- 선택 시 URP shader compile

### 38.3 Unity PlayMode 테스트

- `PixelForgeRigPlayer.Play`
- loop
- speed
- crossfade
- Motion event
- Runtime IK
- Runtime corrective
- attachment 교체
- draw order 변경
- Prefab/Imported GameObject 복제 재생
- disable/enable 후 PlayableGraph 복구
- Scene unload 시 resource 정리

### 38.4 수동 품질 승인

다음 pose를 실제 입력 자산으로 확인한다.

- 팔꿈치 45°, 90°, 120°
- 무릎 45°, 90°, 120°
- 몸통 앞·뒤 굽힘
- 팔이 torso 앞뒤로 이동
- 걸음 loop의 양발 접촉
- 공격 타격 시점
- attachment 전환
- Native와 Baked 출력의 의도된 차이

---

## 39. 완료 조건

### 39.1 최소 제품 완료

- 기존 PixelForge 기능과 테스트가 유지된다.
- 6개 부위 PNG로 인간형 측면 리그를 구성할 수 있다.
- 본, Slot, 메시와 weight를 편집할 수 있다.
- 한 장의 팔과 다리가 2본 가중치로 굽혀진다.
- 관절 corrective를 작성하고 미리볼 수 있다.
- 동일 Character Skin에서 `idle`, `walk`, `attack` 세 Motion을 만들 수 있다.
- 새 Motion을 추가해도 Atlas와 Mesh를 다시 생성할 필요가 없다.
- Unity 6.0 프로젝트에서 외부 유료/제3자 런타임 없이 `.pfrig`가 import된다.
- Imported Main GameObject 또는 그 Prefab Variant를 Scene에 배치하고 세 Motion을 재생할 수 있다.
- 재내보내기 후 기존 Scene reference가 유지된다.
- Unity Baked Sprite 출력도 동작한다.

### 39.2 장기 목표 완료

- 동일 Rig Profile의 여러 Skin에 Motion 공유
- 체형 차이 리타기팅
- Motion Library
- 선택적 Runtime IK
- attachment 라이브러리
- Built-in 및 URP 검증
- Native/Baked 선택 자동 권고

---

## 40. 구현 단계

### Phase 0 — 한쪽 팔 기술 Spike

목표:

- 단일 팔 PNG
- 어깨·팔꿈치·손목
- 2본 계층
- 리본 메시
- 자동 가중치
- Authoring IK
- corrective sample
- `.pfrig`
- Unity Scripted Importer
- Mesh/Clip/Main Object 생성

성공 전에는 전체 UI와 모든 부위를 구현하지 않는다.

### Phase 1 — Project v2와 Rig Core

- 타입
- validation
- 좌표/행렬
- 계층
- 저장/로드
- migration
- History
- pure pose evaluator

### Phase 2 — Setup Workspace

- 6부위 입력
- 배치
- landmark
- Bone/Slot
- mesh 생성
- weight 편집
- setup test pose

### Phase 3 — Motion Authoring

- Motion CRUD
- timeline
- keyframe
- interpolation
- FK
- Authoring IK
- event
- attachment/draw order

### Phase 4 — Corrective

- sample
- auto Arc Bend
- sculpt
- preview
- Unity Blend Shape 변환

### Phase 5 — Unity Native Rig Export

- Atlas
- `.pfrig`
- integration source
- Scripted Importer
- Mesh/Material
- AnimationClip
- Main GameObject
- RigPlayer
- reimport 안정성

### Phase 6 — Runtime 선택 기능

- Runtime IK
- CorrectiveDriver
- SlotOrderDriver
- AttachmentDriver
- crossfade와 event

### Phase 7 — Motion 공유와 리타기팅

- profile compatibility
- normalized track
- target setup pose
- retarget report
- 공용 Motion Library

### Phase 8 — Baked Sprite 연결

- deterministic rasterizer
- sample rate
- alpha/palette cleanup
- 기존 SpriteDocument와 Unity exporter 연결
- 대량 캐릭터 기준 프로파일링

---

## 41. 저장소 변경 예상

```text
src/core/
├─ types.ts                         프로젝트 v2 연결
├─ document.ts                      migration/validation 연결
├─ commands.ts                      rigging history
└─ rig/
   ├─ types.ts
   ├─ validate.ts
   ├─ math.ts
   ├─ hierarchy.ts
   ├─ mesh.ts
   ├─ weights.ts
   ├─ ik.ts
   ├─ corrective.ts
   ├─ animation.ts
   ├─ pose.ts
   ├─ retarget.ts
   └─ bake.ts

src/client/
├─ App.tsx                          Workspace 분리
├─ api.ts                           v2 wire/export
└─ rig/
   ├─ RigWorkspace.tsx
   ├─ RigViewport.tsx
   ├─ RigRenderer.ts
   ├─ PartSetupPanel.tsx
   ├─ RigOutliner.tsx
   ├─ RigInspector.tsx
   ├─ WeightEditor.tsx
   ├─ CorrectiveEditor.tsx
   ├─ MotionTimeline.tsx
   └─ RigExportDialog.tsx

src/server/
├─ app.ts                           Rig export endpoint
├─ project-store.ts                 rig/parts storage
├─ rig-exporters/
│  ├─ unity-native.ts
│  ├─ unity-rig-format.ts
│  ├─ unity-animation.ts
│  ├─ atlas.ts
│  └─ unity-baked.ts
└─ unity-integration/
   ├─ Runtime/
   ├─ Editor/
   └─ Shaders/

tests/
├─ rig-*.test.ts
├─ unity-rig-export.test.ts
└─ project-v2-migration.test.ts

unity-fixture/
├─ Assets/
├─ Packages/
└─ ProjectSettings/
```

기존 `src/client/editor/`, `src/core/animation.ts`와 기존 exporter는 필요한 어댑터 외에는 리그 로직을 포함하지 않는다.

---

## 42. 주요 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 한 장의 2D 이미지에는 보이지 않는 면 정보가 없음 | 극단 포즈는 attachment 교체 사용 |
| 큰 관절 각도에서 메시가 찌그러짐 | support topology, weight 편집, corrective sample |
| Native Rig가 픽셀 격자를 변형함 | Point filter, preview, Baked Sprite 경로 |
| 캐릭터별 체형 차이로 Motion 재사용 실패 | semantic Rig Profile, normalized translation, retarget |
| Unity reimport로 reference 손실 | ScriptedImporter의 결정론적 sub-asset identifier |
| Unity 버전별 API 변화 | Unity 6.0 기준 fixture와 importer version 관리 |
| Renderer 수 증가 | 기본 6개 제한, 중요 캐릭터 Native / 군중 Bake |
| Atlas 변경으로 UV 문제 | stable region ID, bounds 검증, source hash |
| corrective와 topology 불일치 | topologyRevision 검사 및 편집 차단 |
| 범위가 지나치게 커짐 | 한쪽 팔 Spike → slice 단위 진행 |

---

## 43. 최종 의사결정 요약

1. 신규 기능은 Spine 호환 기능이 아니라 **PixelForge 자체 2D 스켈레탈 리깅 시스템**이다.
2. Unity 출력은 `spine-unity`를 사용하지 않는다.
3. Unity 2D Animation 같은 추가 패키지를 필수로 사용하지 않는다.
4. PixelForge 내부 기준 데이터는 `Rig Profile + Character Skin + Corrective Profile + Motion Clip`이다.
5. 기존 `SpriteDocument`와 신규 `RiggingAsset`은 분리한다.
6. 팔과 다리는 분리되지 않은 한 장의 이미지에 2본 weighted mesh를 적용한다.
7. 큰 관절 굽힘은 캐릭터별 corrective deformation으로 보정한다.
8. 제작용 IK는 기본적으로 Unity Bone curve로 베이크한다.
9. Unity는 `.pfrig` Scripted Importer로 Mesh, SkinnedMeshRenderer, AnimationClip과 Main GameObject를 생성한다.
10. Unity sub-asset ID는 UUID 기반으로 결정론적으로 유지한다.
11. 일반 캐릭터는 Native Rig, 대량 군중이나 pixel-perfect 결과는 Baked Sprite를 사용한다.
12. 새 행동 추가 시 기본 외형 Atlas와 Mesh를 재생성하지 않고 Motion 데이터만 추가한다.

---

## 44. 라이선스와 배포

- PixelForge가 생성하는 Unity runtime C#과 Shader source는 PixelForge 저장소의 MIT 라이선스를 따른다.
- 생성 bundle에는 제3자 runtime source나 binary를 포함하지 않는다.
- 사용자는 생성된 integration source를 게임 프로젝트에 포함하고 빌드·배포할 수 있다.
- Unity Editor 전용 importer 코드는 Player build assembly에서 제외되도록 Editor asmdef에 둔다.
- Runtime asmdef는 UnityEngine 기본 모듈 외의 제3자 assembly reference를 가져서는 안 된다.

---

## 45. 참고 자료

Unity 공식 문서:

- [Scripted Importers](https://docs.unity3d.com/6000.0/Documentation/Manual/ScriptedImporters.html)
- [ScriptedImporterAttribute](https://docs.unity3d.com/6000.0/ScriptReference/AssetImporters.ScriptedImporterAttribute.html)
- [AssetImportContext.AddObjectToAsset](https://docs.unity3d.com/6000.0/ScriptReference/AssetImporters.AssetImportContext.AddObjectToAsset.html)
- [Mesh.SetBoneWeights](https://docs.unity3d.com/6000.0/ScriptReference/Mesh.SetBoneWeights.html)
- [BoneWeight1](https://docs.unity3d.com/6000.0/ScriptReference/BoneWeight1.html)
- [Mesh.AddBlendShapeFrame](https://docs.unity3d.com/6000.0/ScriptReference/Mesh.AddBlendShapeFrame.html)
- [AnimationUtility.SetEditorCurve](https://docs.unity3d.com/6000.0/ScriptReference/AnimationUtility.SetEditorCurve.html)
- [AssetPostprocessor](https://docs.unity3d.com/6000.0/ScriptReference/AssetPostprocessor.html)

현재 PixelForge 관련 코드:

- `src/core/types.ts`
- `src/core/document.ts`
- `src/core/commands.ts`
- `src/client/App.tsx`
- `src/client/editor/EditorWorkspace.tsx`
- `src/client/editor/CanvasRenderer.ts`
- `src/server/project-store.ts`
- `src/server/exporters/index.ts`
- `src/server/exporters/unity.ts`
- `src/server/exporters/PixelForgeImporter.cs.txt`
