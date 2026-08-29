// 제보에 붙일 이미지를 브라우저에서 줄여 data URL 로 만든다.
//
// Cloud Storage 를 쓰지 않는 이유: 이 프로젝트에는 버킷이 만들어져 있지 않고
// (설정에 이름만 있다), 새로 켜면 요금제 문제가 걸린다. 스크린샷 한 장은 줄이면
// 수백 KB 라 Firestore 문서 한도(1MiB) 안에 들어간다.

// Firestore 는 색인 항목 하나가 7.5KiB 를 넘으면 쓰기를 거부한다.
// 긴 문자열은 조각내어 배열로 넣는다 — 기록 전사와 같은 방식이다.
export const CHUNK_CHARS = 1500;
export const MAX_CHUNKS = 600; // firestore.rules 의 상한과 같아야 한다

export function chunkText(text, size = CHUNK_CHARS) {
  const s = String(text || "");
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export function joinChunks(chunks) {
  return Array.isArray(chunks) ? chunks.join("") : "";
}

// 조각 수 상한에서 거꾸로 계산한 data URL 길이 상한.
export const MAX_DATAURL_CHARS = CHUNK_CHARS * MAX_CHUNKS;

const MAX_EDGE = 1600; // 긴 변 기준. 스크린샷 글자가 읽힐 만큼은 남는다.
const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.42, 0.3];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽지 못했습니다"));
    };
    img.src = url;
  });
}

// 파일 → { dataUrl, w, h, chars }. 한도 안에 못 넣으면 예외를 던진다.
export async function downscaleImage(file) {
  if (!file || !file.type?.startsWith("image/")) {
    throw new Error("이미지 파일이 아닙니다");
  }
  const img = await loadImage(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // 스크린샷에 투명 배경이 있으면 JPEG 에서 검게 나온다. 흰 바탕을 깔고 그린다.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // 화질을 한 단계씩 낮추며 한도 안에 들어오는 첫 결과를 쓴다.
  for (const q of QUALITY_LADDER) {
    const dataUrl = canvas.toDataURL("image/jpeg", q);
    if (dataUrl.length <= MAX_DATAURL_CHARS) {
      return { dataUrl, w, h, chars: dataUrl.length, quality: q };
    }
  }
  throw new Error("이미지가 너무 큽니다. 화면 일부만 잘라서 올려주세요.");
}
