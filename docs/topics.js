// 국시원 공식 48개 임상표현 + 기본진료술기 3개 = 케이스 58개.
// 플러그인이 올리는 cpx-record 의 topic 값과 맞춰야 하므로,
// 이름은 cpx 스킬 refs/topics.md 의 항목명을 그대로 쓴다.
// 스킬 쪽 목록이 바뀌면 이 파일도 함께 고칠 것.
//
// aliases 는 모델이 항목명을 조금 다르게 적어 올렸을 때를 위한 보조 매칭용이다.
// 정규화(공백·괄호·슬래시 제거) 후에도 안 맞는 경우만 여기에 넣는다.

export const TOPICS = [
  { num: "1", name: "가슴통증", aliases: ["흉통"] },
  { num: "2-1", name: "가정폭력" },
  { num: "2-2", name: "성폭력" },
  { num: "3", name: "객혈" },
  { num: "4", name: "경련" },
  { num: "5", name: "고혈압" },
  { num: "6", name: "관절통증/부기" },
  { num: "7", name: "구토" },
  { num: "8", name: "근력/감각 이상" },
  { num: "9", name: "기분 변화" },
  { num: "10", name: "기억력 저하" },
  { num: "11", name: "기침" },
  { num: "12", name: "나쁜 소식 전하기" },
  { num: "13", name: "두근거림" },
  { num: "14", name: "두통" },
  { num: "15", name: "떨림/운동이상" },
  { num: "16", name: "목통증/허리통증" },
  { num: "17", name: "물질오남용" },
  { num: "18", name: "발열" },
  { num: "19", name: "배뇨 이상" },
  { num: "20-1", name: "배변 이상(변비)", aliases: ["변비"] },
  { num: "20-2", name: "배변 이상(설사)", aliases: ["설사"] },
  { num: "21", name: "복통" },
  { num: "22", name: "불안" },
  { num: "23", name: "붉은색 소변", aliases: ["혈뇨"] },
  { num: "24", name: "산전 진찰" },
  { num: "25-1", name: "성장 지연" },
  { num: "25-2", name: "발달 지연" },
  { num: "26-1", name: "소변량변화(다뇨증)", aliases: ["다뇨", "다뇨증"] },
  { num: "26-2", name: "소변량변화(핍뇨)", aliases: ["핍뇨", "소변량 감소"] },
  { num: "27", name: "소화불량" },
  { num: "28", name: "수면장애", aliases: ["불면"] },
  { num: "29", name: "쉽게 멍이 듦", aliases: ["멍"] },
  { num: "30", name: "실신" },
  { num: "31", name: "어지럼", aliases: ["어지러움", "현훈"] },
  { num: "32", name: "예방접종" },
  { num: "33-1", name: "월경이상" },
  { num: "33-2", name: "월경통" },
  { num: "34-1", name: "유방통" },
  { num: "34-2", name: "유방덩이", aliases: ["유방종괴", "유방 덩어리"] },
  { num: "35-1", name: "음주 상담" },
  { num: "35-2", name: "금연 상담" },
  { num: "36", name: "의식장애" },
  { num: "37", name: "이상지질혈증", aliases: ["고지혈증"] },
  { num: "38", name: "자살" },
  { num: "39", name: "질 분비물/질 출혈" },
  { num: "40", name: "체중 감소" },
  { num: "41", name: "체중 증가/비만", aliases: ["비만"] },
  { num: "42", name: "콧물/코막힘" },
  { num: "43", name: "토혈" },
  { num: "44", name: "피로" },
  { num: "45", name: "피부 발진", aliases: ["발진"] },
  { num: "46", name: "혈변" },
  { num: "47", name: "호흡곤란" },
  { num: "48", name: "황달" },
  { num: "49-1", name: "응급처치 (심정지)", aliases: ["응급처치", "심정지", "심폐소생술", "CPR"] },
  { num: "49-2", name: "상처 관리", aliases: ["상처관리", "창상 관리"] },
  { num: "49-3", name: "채혈 및 혈관 확보", aliases: ["채혈", "혈관 확보", "정맥로 확보"] },
];

// 표기 흔들림을 흡수한다 — 공백·괄호·슬래시·쉼표·가운뎃점을 지우고 소문자로.
export function normalizeTopic(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s()（）[\]/,·・.-]/g, "");
}

// 정규화 이름 → 케이스. 별칭도 같은 케이스를 가리킨다.
const INDEX = new Map();
for (const t of TOPICS) {
  INDEX.set(normalizeTopic(t.name), t);
  for (const a of t.aliases || []) INDEX.set(normalizeTopic(a), t);
}

// 기록의 topic 문자열을 케이스 뱅크 항목에 맞춘다. 못 맞추면 null.
export function matchTopic(raw) {
  const key = normalizeTopic(raw);
  if (!key) return null;
  return INDEX.get(key) || null;
}
