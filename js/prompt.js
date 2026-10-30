// AI(ChatGPT·Claude)에게 줄 골프장 정보 프롬프트. 원본은 여기 하나(앱 저장소 docs/spec-club-import.md 9장 5번).
// 결과 형식은 golfscore-club/1 (앱 저장소 docs/club-info-format.md). 개인 정보가 없어 공개 저장소에 둔다.

export const PROMPT = `너는 골프장 코스 정보를 정리하는 도우미야.
아래 자료(골프장 공식 홈페이지 주소, 붙여 넣은 페이지 글, 첨부한 스코어카드·코스 공략도 그림)에서 정보를 찾아
맨 아래 JSON 형식 그대로 채워서, JSON 코드 블록 하나로만 답해 줘. 설명 문장은 쓰지 마.

골프장: {골프장 이름}
자료: {코스 안내 페이지 주소 / 붙여 넣은 글 / 첨부한 그림}

지켜야 할 것
1. 자료에 보이는 정보만 적어. 모르거나 안 보이면 null, 목록이면 []. 절대 추측해서 채우지 마.
2. 9홀 코스(OUT/IN 또는 코스 이름)마다 홀을 정확히 9개 적어. 27홀·36홀이면 코스를 모두 적어. 코스 순서는 홈페이지 순서대로.
3. number 는 코스 안 순서 1~9, cardNumber 는 스코어카드에 적힌 홀 번호(예: IN 1번 = 10).
4. hcdp 는 스코어카드의 HDCP(핸디캡) 숫자를 그대로 적어. 코스 안 순위(1~9)로만 나와 있으면 그대로 적고 notes 에 알려 줘.
5. 거리는 적힌 숫자 그대로 적고, 단위를 distanceUnit 에 "m" 또는 "yd" 로 적어. 단위를 바꾸지 마. 단위를 모르면 null.
6. tees 에는 거리표의 티 이름을 적힌 그대로(예: 블랙, 블루, 화이트, 레드, 골드) 적고, distances 의 키는 그 이름만 써.
7. description 은 홀 공략 설명을 2~3문장으로 요약해(티샷·세컨드 샷·그린 순서). 원문을 길게 베끼지 마.
8. hazards 에는 OB, 해저드, 벙커, 워터 등 위험 요소를 위치와 함께 짧게(예: "왼쪽 OB", "그린 앞 벙커").
9. greenNote 에는 그린 모양·경사·투그린 여부 등을 한 문장으로.
10. holeImageUrl, greenImageUrl 에는 홀 지도·그린 지도 그림 주소가 보이면 적어(그림 파일 자체는 필요 없어).
11. 9홀 코스 레이팅·슬로프가 있으면 그 코스의 courseRating, slopeRating 에 적어. 18홀 조합 값만 있으면 ratings 에 조합(전반·후반 코스 이름)과 티별로 적어.
12. 헷갈린 점, 자료끼리 다른 값, 확인 못 한 항목은 notes 에 적어.
13. 홀 순서는 페이지에 나온 홀 순서를 따르고, 그림 주소는 파일 이름의 번호와 상관없이 그 홀에 실제로 붙어 있는 그림을 적어. 번호가 서로 다르면 notes 에 알려 줘.
14. "코스 업데이트 예정", "준비 중" 같은 자리표시 글이나 그림은 null 로 적어.
15. 공략 글이 그 홀의 파와 맞지 않아 보이면(예: 파3 홀에 세컨드 샷 설명) description 에 넣지 말고 null 로 두고, notes 에 어느 홀인지와 이유를 적어.

JSON 형식:
{
  "format": "golfscore-club/1",
  "club": {
    "name": "", "region": null, "website": null,
    "tees": [], "distanceUnit": null,
    "nines": [
      { "name": "", "courseRating": null, "slopeRating": null,
        "holes": [
          { "number": 1, "cardNumber": null, "par": null, "hcdp": null,
            "distances": {}, "description": null, "hazards": [], "greenNote": null,
            "holeImageUrl": null, "greenImageUrl": null }
        ] }
    ],
    "ratings": []
  },
  "source": { "urls": [], "checkedAt": "YYYY-MM-DD" },
  "notes": []
}
`;
