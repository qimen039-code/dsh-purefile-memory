"""生成四套自造能力验证集（合成对话+精确 gold），格式与 locomo10.json 相同。

集1 chaos    ：无意义实体+胡言乱语。一半问题在对话中不存在 → gold=unknown（防幻觉）。
集2 detective：隐藏多跳链（谁最后拿了东西/东西在哪/谁看到了谁）。
集3 causal   ：事件序列+显式日期（先后/间隔/因果跟进）。
集4 social   ：人物关系网（兄弟/同事/姐妹/师徒），跨 session 陈述。

用法：python bench/gen_capability_sets.py   → 写入 bench/capsets/*.json
"""
from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "capsets"
OUT.mkdir(exist_ok=True)


def dialog(sample_id: str, sessions: dict[str, tuple[str, list[tuple[str, str]]]]) -> dict:
    conv = {}
    for key, (dt, turns) in sessions.items():
        conv[f"{key}_date_time"] = dt
        conv[key] = json.dumps([{"speaker": s, "text": t} for s, t in turns])
    return {"sample_id": sample_id, "conversation": conv}


def qa_set(qas: list[tuple[str, str, int]]) -> list[dict]:
    return [{"question": q, "answer": a, "category": c} for q, a, c in qas]


# ---------------------------------------------------------------- 1. chaos
chaos = dialog("cap-chaos-1", {
    "session_1": ("2:15 pm on 3 April, 2023", [
        ("Zorblatt", "The quixnorian festival starts nexula. I will wear my tramelda cloak."),
        ("Vexwold", "Amazing! Last time the festival had a plimworth contest, right?"),
        ("Zorblatt", "Yes! I won third place with my gronzik soup. The judge was Hesperion."),
        ("Vexwold", "My snorbette broke during the dance. I was so upset."),
        ("Zorblatt", "You should ask Quellmira to fix it. She repaired my uncle's snorbette once."),
    ]),
    "session_2": ("5:40 pm on 19 April, 2023", [
        ("Vexwold", "Quellmira fixed my snorbette in two days! She is a genius."),
        ("Zorblatt", "Great! Did you hear Hesperion retired from judging?"),
        ("Vexwold", "Really? Who judges the plimworth contest now?"),
        ("Zorblatt", "Draventhil. He is much stricter, gives lower scores."),
        ("Vexwold", "Then I will not enter this year. I will just sell glimble cakes instead."),
    ]),
})
chaos_qa = qa_set([
    # answerable（内容在对话中）
    ("Who won third place in the plimworth contest?", "Zorblatt", 1),
    ("Who fixed Vexwold's snorbette?", "Quellmira", 1),
    ("Who is the new judge of the plimworth contest?", "Draventhil", 1),
    ("What did Vexwold decide to sell instead of entering the contest?", "glimble cakes", 1),
    ("When did the second conversation happen?", "19 April 2023", 2),
    ("Who repaired Zorblatt's uncle's snorbette?", "Quellmira", 3),
    # NOT in dialogue（防幻觉；gold=unknown）
    ("What color is Zorblatt's tramelda cloak?", "unknown", 5),
    ("Where is the quixnorian festival held?", "unknown", 5),
    ("How many years has Vexwold danced?", "unknown", 5),
    ("Did Zorblatt ever meet Draventhil in person?", "unknown", 5),
    ("What ingredients are in gronzik soup?", "unknown", 5),
    ("Why did Hesperion retire?", "unknown", 5),
])

# ---------------------------------------------------------------- 2. detective
det = dialog("cap-detective-1", {
    "session_1": ("10:00 am on 2 May, 2023", [
        ("Riley", "Morning! I left the brass key on the kitchen shelf yesterday."),
        ("Morgan", "Got it. I moved the brass key to the lockbox in the garage at noon."),
        ("Riley", "Perfect. Did you see the red ledger anywhere? I need it for the audit."),
        ("Morgan", "Quinn borrowed the red ledger on Monday for the archive room."),
    ]),
    "session_2": ("4:30 pm on 4 May, 2023", [
        ("Quinn", "I returned the red ledger to Morgan on Wednesday evening."),
        ("Morgan", "Yes, and I put it back in the top drawer of the study desk."),
        ("Riley", "Thanks! Also, who took the magnifier from the lab?"),
        ("Quinn", "That was Sasha. Sasha took the magnifier to the field site on Tuesday."),
    ]),
    "session_3": ("9:15 am on 6 May, 2023", [
        ("Sasha", "The magnifier is back in the lab cabinet now. I brought it Friday."),
        ("Riley", "Great. So everything is where it should be?"),
        ("Morgan", "Except the brass key is still in the garage lockbox. I haven't moved it since."),
        ("Quinn", "I can move it to the office drawer tomorrow if you want."),
    ]),
})
det_qa = qa_set([
    ("Where is the brass key now?", "in the garage lockbox", 3),
    ("Who last moved the brass key, and where did they put it?", "Morgan, to the garage lockbox", 3),
    ("Who borrowed the red ledger first?", "Quinn", 3),
    ("Where is the red ledger now?", "top drawer of the study desk", 3),
    ("Who took the magnifier to the field site?", "Sasha", 3),
    ("Where is the magnifier now?", "in the lab cabinet", 3),
    ("Who will move the brass key to the office drawer?", "Quinn", 1),
    ("On what date did Quinn borrow the red ledger?", "Monday, 1 May 2023", 2),
    ("What did Riley leave on the kitchen shelf?", "the brass key", 1),
    ("When did Sasha bring the magnifier back to the lab cabinet?", "Friday, 5 May 2023", 2),
    ("What did Morgan do with the brass key at noon on 2 May?", "moved it to the garage lockbox", 2),
    ("Where did Morgan put the red ledger after Quinn returned it?", "top drawer of the study desk", 3),
])

# ---------------------------------------------------------------- 3. causal
cau = dialog("cap-causal-1", {
    "session_1": ("6:00 pm on 12 March, 2023", [
        ("Talia", "I started building the greenhouse in February 2023."),
        ("Dario", "How is it going?"),
        ("Talia", "Finished the frame in March 2023, but the storm broke two panels last week."),
        ("Dario", "Sorry to hear. What next?"),
    ]),
    "session_2": ("3:20 pm on 9 June, 2023", [
        ("Talia", "I replaced the broken panels in April 2023 and planted tomatoes in May 2023."),
        ("Dario", "And?"),
        ("Talia", "The tomatoes died in a heatwave in late May 2023. I switched to peppers."),
        ("Dario", "Smart. Peppers handle heat better."),
    ]),
    "session_3": ("1:00 pm on 21 September, 2023", [
        ("Talia", "The peppers are thriving. First harvest was August 2023."),
        ("Dario", "Any plans for winter?"),
        ("Talia", "I will insulate the greenhouse in October 2023 and try winter lettuce."),
        ("Dario", "After the heatwave disaster, you have earned a win."),
    ]),
})
cau_qa = qa_set([
    ("When did Talia start building the greenhouse?", "February 2023", 2),
    ("When did Talia finish the greenhouse frame?", "March 2023", 2),
    ("What happened to the tomatoes, and when?", "they died in a heatwave in late May 2023", 2),
    ("What did Talia plant after the tomatoes died?", "peppers", 3),
    ("When was the first pepper harvest?", "August 2023", 2),
    ("How many months passed between finishing the frame and the first harvest?", "five months (March 2023 to August 2023)", 2),
    ("What will Talia do in October 2023?", "insulate the greenhouse and try winter lettuce", 2),
    ("What broke two panels of the greenhouse?", "a storm in March 2023", 2),
    ("When did Talia replace the broken panels?", "April 2023", 2),
    ("What happened before the tomatoes were planted?", "Talia replaced the broken panels in April 2023", 3),
    ("Which crop does Dario say handles heat better?", "peppers", 1),
    ("What sequence of crops did Talia grow?", "tomatoes first, then peppers", 3),
])

# ---------------------------------------------------------------- 4. social
soc = dialog("cap-social-1", {
    "session_1": ("11:30 am on 8 January, 2023", [
        ("Elias", "My sister Freya just moved to Lisbon for her new job at Atlantica Labs."),
        ("Gunnar", "Nice! My cousin Hilda works there too, in the robotics team."),
        ("Elias", "Small world. Freya is on the data platform team."),
    ]),
    "session_2": ("2:45 pm on 15 February, 2023", [
        ("Gunnar", "Hilda says her teammate Jonas is Freya's manager."),
        ("Elias", "That matches what Freya told me. Jonas reports to Director Kwan."),
        ("Gunnar", "And Kwan?"),
        ("Elias", "Kwan founded Atlantica Labs with Ilsa back in 2018."),
    ]),
    "session_3": ("5:10 pm on 3 March, 2023", [
        ("Elias", "Freya's fiancé Torben is transferring to the Lisbon office in April."),
        ("Gunnar", "So the whole family gathers there. Is Torben an engineer too?"),
        ("Elias", "Yes, he and Hilda studied at the same university."),
        ("Gunnar", "I will ask Hilda to show them around."),
    ]),
})
soc_qa = qa_set([
    ("Who is Elias's sister?", "Freya", 1),
    ("Where does Freya work?", "Atlantica Labs in Lisbon", 1),
    ("Who is Freya's manager?", "Jonas", 3),
    ("Who does Jonas report to?", "Director Kwan", 3),
    ("Who founded Atlantica Labs, and when?", "Kwan and Ilsa in 2018", 3),
    ("Who is Freya's fiancé?", "Torben", 1),
    ("When is Torben transferring to the Lisbon office?", "April 2023", 2),
    ("Whose cousin is Hilda?", "Gunnar's", 1),
    ("What is the relationship between Torben and Hilda?", "they studied at the same university", 3),
    ("Which team does Hilda work on?", "the robotics team", 1),
    ("How are Elias and Freya related?", "brother and sister", 3),
    ("When did the first conversation happen?", "8 January 2023", 2),
])

SETS = {
    "chaos": (chaos, chaos_qa),
    "detective": (det, det_qa),
    "causal": (cau, cau_qa),
    "social": (soc, soc_qa),
}

for name, (d, qas) in SETS.items():
    payload = {"sample_id": d["sample_id"], "conversation": d["conversation"], "qa": qas}
    out = OUT / f"{name}.json"
    out.write_text(json.dumps([payload], ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out} ({len(qas)} qa)")
