import React, { useState, useEffect, useRef, useMemo } from "react";
import { Clock, ChevronRight, ChevronLeft, RotateCcw, Home, BookOpen } from "lucide-react";
import { sb, sbInsert } from "./supabase";

const OPEN_QUESTIONS = [
  { id: "o-a1", level: "A1", topic: "Vorstellung", q: "Stell dich in 1-2 Sätzen auf Deutsch vor (Name, Herkunft).", keywords: ["ich heiße", "ich komme", "ich bin"] },
  { id: "o-a2", level: "A2", topic: "Perfekt", q: "Schreibe einen Satz im Perfekt über dein Wochenende.", keywords: ["habe", "bin", "gemacht", "gegangen", "gespielt", "gefahren"] },
  { id: "o-b1", level: "B1", topic: "Nebensatz", q: "Bilde einen Satz mit 'weil' oder 'obwohl'.", keywords: ["weil", "obwohl"] },
  { id: "o-b2", level: "B2", topic: "Konjunktiv II", q: "Was würdest du tun, wenn du reich wärst? (ein Satz)", keywords: ["würde", "wäre"] },
];

const LEVELS = ["A1", "A2", "B1", "B2"];
const PASS_THRESHOLD = 60; // % — TELC-tərzi keçid həddi

/* ---------- helpers ---------- */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function shuffleOptions(mc) {
  const idx = shuffle(mc.options.map((_, i) => i));
  return {
    ...mc,
    options: idx.map((i) => mc.options[i]),
    correct: idx.indexOf(mc.correct),
  };
}
function gradeFor(pct) {
  if (pct >= 90) return { de: "Sehr gut", color: "#6FA787" };
  if (pct >= 75) return { de: "Gut", color: "#8FBF9F" };
  if (pct >= 60) return { de: "Befriedigend", color: "#C9A15A" };
  if (pct >= 50) return { de: "Ausreichend", color: "#D9A75A" };
  return { de: "Nicht bestanden", color: "#C97B6E" };
}
function fmtTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

/* ========================================================================= */

export default function App() {
  const [screen, setScreen] = useState("portal"); // portal | home | setup | test | result
  const [name, setName] = useState("");
  const [mode, setMode] = useState(null); // 'level' | 'check'
  const [selectedLevel, setSelectedLevel] = useState("A1");
  const [numQuestions, setNumQuestions] = useState(20);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [openAnswers, setOpenAnswers] = useState({});
  const [current, setCurrent] = useState(0);
  const [timeLeft, setTimeLeft] = useState(45 * 60);
  const [finished, setFinished] = useState(false);
  const [revealPhase, setRevealPhase] = useState("spin"); // spin | revealed
  const timerRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => {
    if (screen === "test" && timeLeft > 0 && !finished) {
      timerRef.current = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    } else if (timeLeft <= 0 && screen === "test" && !finished) {
      handleFinish();
    }
    return () => clearTimeout(timerRef.current);
  }, [timeLeft, screen, finished]);

  useEffect(() => {
    if (finished) {
      setRevealPhase("spin");
      const t = setTimeout(() => {
        setRevealPhase("revealed");
        setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
      }, 1700);
      return () => clearTimeout(t);
    }
  }, [finished]);

  async function getUsedIds(key) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : [];
    } catch {
      return [];
    }
  }
  async function saveUsedIds(key, ids) {
    try {
      localStorage.setItem(key, JSON.stringify(ids.slice(-500)));
    } catch {}
  }

  async function buildLevelTest(level, count) {
    const key = `used:${name || "guest"}:${level}`;
    const used = await getUsedIds(key);
    const rows = await sb(`questions?level=eq.${level}&select=id,level,topic,question,option_a,option_b,option_c,correct&limit=4000`);
    const pool = rows.map((r) => ({
      id: r.id, level: r.level, topic: r.topic, q: r.question,
      options: [r.option_a, r.option_b, r.option_c].filter((o) => o !== null && o !== ""),
      correct: r.correct,
    }));
    const unseen = pool.filter((q) => !used.includes(q.id));
    const ordered = [...unseen, ...pool.filter((q) => used.includes(q.id))];
    const picked = shuffle(ordered).slice(0, Math.min(count, pool.length)).map((q) => ({ ...shuffleOptions(q), level }));
    await saveUsedIds(key, [...used, ...picked.map((q) => q.id)]);
    return picked;
  }

  async function buildCheckTest() {
    const perLevel = Math.floor(45 / LEVELS.length / 1); // ~11 mc per level within 45 total incl. open
    const mcPerLevel = 10; // 4 x 10 = 40 mc
    let all = [];
    for (const lvl of LEVELS) {
      const test = await buildLevelTest(lvl, mcPerLevel);
      all = [...all, ...test];
      const openQ = OPEN_QUESTIONS.find((o) => o.level === lvl);
      if (openQ) all.push({ ...openQ, isOpen: true, level: lvl });
    }
    return all; // 40 mc + 4 open = 44, close enough to 45 with this sample pool
  }

  async function startTest() {
    setAnswers({});
    setOpenAnswers({});
    setCurrent(0);
    setTimeLeft(45 * 60);
    setFinished(false);
    const qs = mode === "level" ? await buildLevelTest(selectedLevel, numQuestions) : await buildCheckTest();
    setQuestions(qs);
    setScreen("test");
  }

  function handleFinish() {
    clearTimeout(timerRef.current);
    setFinished(true);
  }

  const results = useMemo(() => {
    if (!finished) return null;
    const byLevel = {};
    for (const lvl of LEVELS) byLevel[lvl] = { correct: 0, wrong: 0, total: 0, wrongTopics: {} };
    const reviewList = [];

    questions.forEach((q, i) => {
      const lvl = q.level;
      if (!byLevel[lvl]) byLevel[lvl] = { correct: 0, wrong: 0, total: 0, wrongTopics: {} };
      byLevel[lvl].total += 1;
      if (q.isOpen) {
        const ans = (openAnswers[q.id] || "").toLowerCase();
        const ok = q.keywords.some((k) => ans.includes(k.toLowerCase()));
        if (ok) byLevel[lvl].correct += 1;
        else {
          byLevel[lvl].wrong += 1;
          byLevel[lvl].wrongTopics[q.topic] = (byLevel[lvl].wrongTopics[q.topic] || 0) + 1;
        }
        reviewList.push({ i, q: q.q, isOpen: true, userAnswer: openAnswers[q.id] || "(boş)", correctAnswer: "—", ok });
      } else {
        const userIdx = answers[q.id];
        const ok = userIdx === q.correct;
        if (ok) byLevel[lvl].correct += 1;
        else {
          byLevel[lvl].wrong += 1;
          byLevel[lvl].wrongTopics[q.topic] = (byLevel[lvl].wrongTopics[q.topic] || 0) + 1;
        }
        reviewList.push({
          i, q: q.q, isOpen: false,
          userAnswer: userIdx !== undefined ? q.options[userIdx] : "(cavabsız)",
          correctAnswer: q.options[q.correct], ok,
        });
      }
    });

    const levelStats = {};
    for (const lvl of LEVELS) {
      const s = byLevel[lvl];
      if (s.total === 0) continue;
      const corrected = Math.max(0, ((s.correct - s.wrong / 3) / s.total) * 100);
      levelStats[lvl] = { ...s, pct: Math.round(corrected) };
    }

    let finalLevel = null;
    if (mode === "check") {
      for (const lvl of LEVELS) {
        if (!levelStats[lvl]) continue;
        if (levelStats[lvl].pct >= PASS_THRESHOLD) finalLevel = lvl;
        else break;
      }
      if (!finalLevel) finalLevel = "A1 altı";
    } else {
      finalLevel = selectedLevel;
    }

    // time bonus only for single-level exam mode, and only if passed
    let bonus = 0;
    const overallStats = mode === "level" ? levelStats[selectedLevel] : null;
    if (mode === "level" && overallStats && overallStats.pct >= PASS_THRESHOLD) {
      const savedMin = Math.floor(timeLeft / 60);
      bonus = Math.min(5, Math.floor(savedMin / 5));
    }
    const finalPct = mode === "level" ? Math.min(100, (overallStats?.pct || 0) + bonus) : null;

    const weakTopics = {};
    for (const lvl of LEVELS) {
      const wt = byLevel[lvl]?.wrongTopics || {};
      for (const t in wt) weakTopics[t] = (weakTopics[t] || 0) + wt[t];
    }
    const weakList = Object.entries(weakTopics).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return { levelStats, finalLevel, finalPct, bonus, reviewList, weakList };
  }, [finished]);

  const savedResultRef = useRef(false);
  useEffect(() => {
    if (finished && results && !savedResultRef.current) {
      savedResultRef.current = true;
      sbInsert("test_results", {
        user_name: name || "Qonaq",
        mode,
        level: mode === "level" ? selectedLevel : results.finalLevel,
        score: mode === "level" ? results.finalPct : null,
        details: results,
      }).catch(() => {});
    }
    if (!finished) savedResultRef.current = false;
  }, [finished, results]);

  /* ---------------- SCREENS ---------------- */

  if (screen === "portal") {
    return <Portal onStart={() => setScreen("home")} />;
  }

  if (screen === "home") {
    return (
      <Shell>
        <button onClick={() => setScreen("portal")} style={styles.backBtn}><ChevronLeft size={16} /> Ana səhifə</button>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 46, marginBottom: 8 }}>🥨</div>
          <h1 style={styles.h1}>Deutsch Akademie</h1>
          <p style={styles.sub}>Online Test Platforması</p>
        </div>

        <label style={styles.label}>Adın</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Adını yaz..."
          style={styles.input}
        />

        <div style={{ marginTop: 28 }}>
          <div style={styles.label}>Nə etmək istəyirsən?</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginTop: 10 }}>
            {LEVELS.map((lvl) => (
              <button key={lvl} onClick={() => { setMode("level"); setSelectedLevel(lvl); setScreen("setup"); }}
                style={{ ...styles.card, ...(selectedLevel === lvl && mode === "level" ? styles.cardActive : {}) }}>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{lvl}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Səviyyə imtahanı</div>
              </button>
            ))}
            <button onClick={() => { setMode("check"); setScreen("setup"); }}
              style={{ ...styles.card, ...styles.cardGold, gridColumn: "span 2" }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>🔍 Səviyyəni yoxla</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>A1→B2 qarışıq, 45 sual</div>
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (screen === "setup") {
    return (
      <Shell>
        <button onClick={() => setScreen("home")} style={styles.backBtn}><ChevronLeft size={16} /> Geri</button>
        <h2 style={styles.h2}>{mode === "check" ? "Səviyyəni yoxla" : `${selectedLevel} İmtahanı`}</h2>

        {mode === "level" && (
          <>
            <p style={styles.sub}>Neçə sual istəyirsən?</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
              {[20, 35, 50, 100].map((n) => (
                <button key={n} onClick={() => setNumQuestions(n)}
                  style={{ ...styles.pill, ...(numQuestions === n ? styles.pillActive : {}) }}>{n} sual</button>
              ))}
            </div>
          </>
        )}
        {mode === "check" && (
          <p style={styles.sub}>45 sual (A1→B2 qarışıq + açıq suallar), 45 dəqiqə. Nəticədə hansı səviyyəyə çatdığın müəyyənləşəcək.</p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0", color: "#C9A15A" }}>
          <Clock size={18} /> <span>Vaxt həddi: 45 dəqiqə</span>
        </div>

        <button onClick={startTest} style={styles.primaryBtn}>Başla</button>
      </Shell>
    );
  }

  if (screen === "test" && !finished) {
    const q = questions[current];
    if (!q) return <Shell><p>Sual tapılmadı.</p></Shell>;
    return (
      <Shell wide>
        <div style={styles.testHeader}>
          <button onClick={() => setScreen("home")} style={styles.exitBtn}><ChevronLeft size={15} /> Çıx</button>
          <span style={{ opacity: 0.8 }}>Sual {current + 1}/{questions.length}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: timeLeft < 300 ? "#C97B6E" : "#C9A15A" }}>
            <Clock size={16} /> {fmtTime(timeLeft)}
          </span>
        </div>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${((current + 1) / questions.length) * 100}%` }} />
        </div>

        <div style={{ margin: "28px 0" }}>
          <div style={{ fontSize: 12, color: "#C9A15A", marginBottom: 8 }}>{q.level} · {q.topic}</div>
          <p style={styles.question}>{q.q}</p>

          {q.isOpen ? (
            <textarea
              value={openAnswers[q.id] || ""}
              onChange={(e) => setOpenAnswers({ ...openAnswers, [q.id]: e.target.value })}
              placeholder="Cavabını buraya yaz..."
              style={styles.textarea}
            />
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {q.options.map((opt, i) => (
                <button key={i} onClick={() => setAnswers({ ...answers, [q.id]: i })}
                  style={{ ...styles.option, ...(answers[q.id] === i ? styles.optionActive : {}) }}>
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}
            style={{ ...styles.secondaryBtn, opacity: current === 0 ? 0.4 : 1 }}>
            <ChevronLeft size={16} /> Geri
          </button>
          {current < questions.length - 1 ? (
            <button onClick={() => setCurrent((c) => c + 1)} style={styles.primaryBtn}>Növbəti <ChevronRight size={16} /></button>
          ) : (
            <button onClick={handleFinish} style={styles.primaryBtn}>Bitir</button>
          )}
        </div>
      </Shell>
    );
  }

  if (finished) {
    return (
      <Shell wide>
        {revealPhase === "spin" ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 320 }}>
            <div style={{ fontSize: 64, animation: "spin 1.2s linear infinite" }}>🥨</div>
            <p style={{ marginTop: 16, color: "#C9A15A" }}>Nəticə hesablanır...</p>
            <style>{`@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
          </div>
        ) : (
          <div>
            <div style={{ textAlign: "center", padding: "20px 0 30px" }}>
              <div style={{ fontSize: 40 }}>🥨</div>
              <h2 style={{ ...styles.h1, fontSize: 30 }}>
                Sənin səviyyən: <span style={{ color: "#C9A15A" }}>{results.finalLevel}</span>
              </h2>
              {mode === "level" && (
                <p style={{ fontSize: 20, marginTop: 6 }}>
                  {results.finalPct}% — <span style={{ color: gradeFor(results.finalPct).color }}>{gradeFor(results.finalPct).de}</span>
                  {results.bonus > 0 && <span style={{ fontSize: 13, opacity: 0.7 }}> (+{results.bonus}% sürət bonusu)</span>}
                </p>
              )}
            </div>

            <div ref={resultRef}>
              <h3 style={styles.h3}>Səviyyə üzrə göstərici</h3>
              <div style={{ display: "grid", gap: 10, marginBottom: 28 }}>
                {LEVELS.filter((l) => results.levelStats[l]).map((lvl) => {
                  const s = results.levelStats[lvl];
                  const g = gradeFor(s.pct);
                  return (
                    <div key={lvl} style={styles.statRow}>
                      <span style={{ width: 32, fontWeight: 700 }}>{lvl}</span>
                      <div style={styles.statTrack}>
                        <div style={{ ...styles.statFill, width: `${s.pct}%`, background: g.color }} />
                      </div>
                      <span style={{ width: 100, textAlign: "right", fontSize: 13 }}>{s.pct}% · {g.de}</span>
                    </div>
                  );
                })}
              </div>

              <h3 style={styles.h3}>Sualların təhlili</h3>
              <div style={{ display: "grid", gap: 8, marginBottom: 28, maxHeight: 300, overflowY: "auto" }}>
                {results.reviewList.map((r) => (
                  <div key={r.i} style={{ ...styles.reviewRow, borderLeft: `3px solid ${r.ok ? "#6FA787" : "#C97B6E"}` }}>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>{r.i + 1}. {r.q}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                      Sənin cavabın: {r.userAnswer} {!r.ok && r.correctAnswer !== "—" && <>· Düzgün: {r.correctAnswer}</>}
                    </div>
                  </div>
                ))}
              </div>

              {results.weakList.length > 0 && (
                <div style={styles.adBox}>
                  <h3 style={{ ...styles.h3, marginTop: 0 }}>Zəif olduğun mövzular</h3>
                  <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
                    {results.weakList.map(([topic, count]) => (
                      <li key={topic} style={{ marginBottom: 4 }}>{topic} <span style={{ opacity: 0.6 }}>({count} səhv)</span></li>
                    ))}
                  </ul>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, color: "#C9A15A" }}>
                    <BookOpen size={18} />
                    <span style={{ fontSize: 13 }}>Bu mövzuları Deutsch Akademie kitablarımızda daha ətraflı tapa bilərsən.</span>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
              <button onClick={() => setScreen("portal")} style={styles.secondaryBtn}><Home size={16} /> Əsas ekran</button>
              <button onClick={() => { setScreen("setup"); setFinished(false); }} style={styles.primaryBtn}><RotateCcw size={16} /> Yenidən cəhd et</button>
              <button onClick={async () => {
                const text = mode === "level"
                  ? `Deutsch Akademie testində ${selectedLevel} səviyyəsindən ${results.finalPct}% topladım! 🥨`
                  : `Deutsch Akademie-də alman dili səviyyəmi yoxladım: ${results.finalLevel} 🥨`;
                if (navigator.share) {
                  try { await navigator.share({ text }); } catch {}
                } else {
                  try { await navigator.clipboard.writeText(text); alert("Nəticə kopyalandı!"); } catch {}
                }
              }} style={styles.secondaryBtn}>Paylaş</button>
            </div>
          </div>
        )}
      </Shell>
    );
  }

  return null;
}

function LessonVocab({ level, num }) {
  const [vocab, setVocab] = useState(null);
  useEffect(() => {
    let alive = true;
    sb(`lesson_vocab?level=eq.${level}&lesson_num=eq.${num}&select=term,translation`)
      .then((rows) => { if (alive) setVocab(rows); })
      .catch(() => { if (alive) setVocab([]); });
    return () => { alive = false; };
  }, [level, num]);
  if (!vocab || vocab.length === 0) return null;
  return (
    <div style={portalStyles.vocabBox}>
      <div style={portalStyles.vocabTitle}>📎 Bu mövzu ilə paralel öyrən</div>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        {vocab.map((v, i) => (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5 }}>
            <span style={{ color: "#FF9F1C", fontWeight: 700, minWidth: 110 }}>{v.term}</span>
            <span style={{ opacity: 0.75 }}>{v.translation}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LessonsView({ topicsByLevel }) {
  const [level, setLevel] = useState("A1");
  const [openTopic, setOpenTopic] = useState(null);
  const [lessons, setLessons] = useState([]);
  useEffect(() => {
    let alive = true;
    sb(`lessons?level=eq.${level}&select=level,num,title,content`)
      .then((rows) => { if (alive) setLessons(rows.sort((a, b) => parseInt(a.num) - parseInt(b.num))); })
      .catch(() => { if (alive) setLessons([]); });
    return () => { alive = false; };
  }, [level]);
  const hasContent = lessons.length > 0;

  return (
    <section style={portalStyles.section}>
      <h2 style={portalStyles.h2}>Dərslər</h2>
      <p style={{ ...portalStyles.body, marginBottom: 20 }}>Səviyyə seç, mövzuya klikləyib izahı aç.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {LEVELS.map((lvl) => (
          <button key={lvl} onClick={() => { setLevel(lvl); setOpenTopic(null); }}
            style={{ ...portalStyles.pill, ...(level === lvl ? portalStyles.pillActive : {}) }}>{lvl}</button>
        ))}
      </div>

      {hasContent ? (
        <div style={{ display: "grid", gap: 10 }}>
          {lessons.map((l) => {
            const isOpen = openTopic === l.num;
            return (
              <div key={l.num} style={portalStyles.lessonCard}>
                <button onClick={() => setOpenTopic(isOpen ? null : l.num)} style={portalStyles.lessonHeader}>
                  <span>{l.num}. {l.title}</span>
                  <ChevronRight size={16} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
                </button>
                {isOpen && (
                  <div style={portalStyles.lessonBodyWrap}>
                    <pre style={portalStyles.lessonBody}>{l.content}</pre>
                    <LessonVocab level={level} num={l.num} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={portalStyles.grid}>
          {(topicsByLevel[level] || []).map((topic) => (
            <div key={topic} style={portalStyles.card}>
              <h3 style={{ ...portalStyles.cardTitle, fontSize: 15 }}>{topic}</h3>
              <p style={portalStyles.cardText}>Tezliklə: ətraflı izah, cədvəllər və nümunə cümlələr.</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DictionaryView() {
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("de-az"); // de-az | az-de
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let alive = true;
    const timer = setTimeout(() => {
      sb(`dictionary?direction=eq.${direction}&or=(term.ilike.*${encodeURIComponent(q)}*,translation.ilike.*${encodeURIComponent(q)}*)&select=term,translation&limit=60`)
        .then((rows) => { if (alive) setResults(rows); })
        .catch(() => { if (alive) setResults([]); });
    }, 250); // debounce so we don't hit the server on every keystroke
    return () => { alive = false; clearTimeout(timer); };
  }, [query, direction]);

  return (
    <section style={portalStyles.section}>
      <h2 style={portalStyles.h2}>Lüğət</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setDirection("de-az")} style={{ ...portalStyles.pill, ...(direction === "de-az" ? portalStyles.pillActive : {}) }}>Alman → Azərbaycan</button>
        <button onClick={() => setDirection("az-de")} style={{ ...portalStyles.pill, ...(direction === "az-de" ? portalStyles.pillActive : {}) }}>Azərbaycan → Alman</button>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={direction === "de-az" ? "Söz axtar... (məs. Arbeit)" : "Söz axtar... (məs. iş)"}
        style={portalStyles.input}
      />
      <p style={{ fontSize: 12.5, opacity: 0.55, marginTop: 8 }}>
        Minlərlə söz bu lüğətdə mövcuddur — axtarmaq üçün ən azı 2 hərf yaz
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 16, maxHeight: 420, overflowY: "auto" }}>
        {results.map((r, i) => (
          <div key={i} style={portalStyles.dictRow}>
            <div style={portalStyles.dictTerm}>{r.term}</div>
            <div style={portalStyles.dictTrans}>{r.translation}</div>
          </div>
        ))}
        {query.trim().length >= 2 && results.length === 0 && (
          <p style={{ opacity: 0.6, fontSize: 14 }}>Nəticə tapılmadı.</p>
        )}
      </div>
    </section>
  );
}

function useReveal() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

function Reveal({ children, delay = 0 }) {
  const [ref, visible] = useReveal();
  return (
    <div ref={ref} style={{
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(24px)",
      transition: `opacity .7s ease ${delay}s, transform .7s cubic-bezier(.2,.7,.3,1) ${delay}s`,
    }}>
      {children}
    </div>
  );
}

function TiltCard({ children, style, onClick, as: As = "div" }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(false);
  const reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function onMove(e) {
    if (reduced || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    ref.current.style.transform = `perspective(700px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 8).toFixed(2)}deg) translateZ(0)`;
    ref.current.style.setProperty("--gx", `${(px + 0.5) * 100}%`);
    ref.current.style.setProperty("--gy", `${(py + 0.5) * 100}%`);
  }
  function onLeave() {
    setHover(false);
    if (!ref.current) return;
    ref.current.style.transform = "perspective(700px) rotateX(0deg) rotateY(0deg)";
  }

  return (
    <As ref={ref} onMouseMove={onMove} onMouseEnter={() => setHover(true)} onMouseLeave={onLeave} onClick={onClick}
      style={{ ...style, transition: "transform .15s ease-out", willChange: "transform" }}>
      <div style={{ ...portalStyles.tiltGlow, opacity: hover ? 1 : 0 }} />
      {children}
    </As>
  );
}

function Portal({ onStart }) {
  const [view, setView] = useState("home"); // home | lessons | dictionary | courses | contact
  const [regForm, setRegForm] = useState({ name: "", phone: "", course: "A1" });
  const [regSent, setRegSent] = useState(false);
  const glowRef = useRef(null);
  const [streak, setStreak] = useState(null);

  useEffect(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      let data = { lastDate: null, count: 0 };
      const v = localStorage.getItem("visitStreak");
      if (v) data = JSON.parse(v);
      if (data.lastDate === today) {
        setStreak(data.count || 1);
        return;
      }
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const newCount = data.lastDate === yesterday ? (data.count || 0) + 1 : 1;
      localStorage.setItem("visitStreak", JSON.stringify({ lastDate: today, count: newCount }));
      setStreak(newCount);
    } catch {}
  }, []);

  useEffect(() => {
    function onMove(e) {
      if (glowRef.current) {
        glowRef.current.style.background = `radial-gradient(600px circle at ${e.clientX}px ${e.clientY}px, rgba(255,159,28,0.10), transparent 60%)`;
      }
    }
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  const [topicsByLevel, setTopicsByLevel] = useState({ A1: [], A2: [], B1: [], B2: [] });
  useEffect(() => {
    let alive = true;
    Promise.all(LEVELS.map((lvl) =>
      sb(`questions?level=eq.${lvl}&select=topic&limit=2000`).catch(() => [])
    )).then((results) => {
      if (!alive) return;
      const out = {};
      LEVELS.forEach((lvl, i) => { out[lvl] = [...new Set(results[i].map((r) => r.topic))]; });
      setTopicsByLevel(out);
    });
    return () => { alive = false; };
  }, []);

  const navItems = [
    { key: "home", label: "Ana səhifə" },
    { key: "lessons", label: "Dərslər" },
    { key: "dictionary", label: "Lüğət" },
    { key: "courses", label: "Kurslar" },
    { key: "contact", label: "Əlaqə" },
  ];

  return (
    <div style={portalStyles.page}>
      <style>{`
        @keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(40px,-30px) scale(1.1); } }
        @keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-50px,40px) scale(1.15); } }
        @keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(30px,30px) scale(0.95); } }
        @media (prefers-reduced-motion: reduce) { .blob { animation: none !important; } }
        button, input, select { -webkit-tap-highlight-color: transparent; appearance: none; outline: none; font-family: inherit; }
        button:focus-visible { box-shadow: 0 0 0 2px rgba(255,255,255,0.6); }
      `}</style>

      <div ref={glowRef} style={portalStyles.cursorGlow} />
      <div style={{ ...portalStyles.bigShape, top: "-18%", right: "-14%", background: "linear-gradient(135deg,#FF9F1C,#E63946)" }} />
      <div style={portalStyles.bigShapeOutline} />

      {/* Nav bar */}
      <nav style={portalStyles.nav}>
        <div style={portalStyles.navBrand} onClick={() => setView("home")}>
          <div style={portalStyles.navEmblem}><BookOpen size={16} color="#0B2E33" /></div>
          <span style={portalStyles.navBrandText}>Deutsch Akademie</span>
        </div>
        <div style={portalStyles.navLinks}>
          {navItems.map((n) => (
            <button key={n.key} onClick={() => setView(n.key)}
              style={{ ...portalStyles.navLink, ...(view === n.key ? portalStyles.navLinkActive : {}) }}>
              {n.label}
            </button>
          ))}
        </div>
      </nav>

      <div style={portalStyles.content}>
        {view === "home" && (
          <>
            <Reveal>
              <div style={portalStyles.hero}>
                <div style={portalStyles.emblem}>
                  <div style={portalStyles.emblemRing}><BookOpen size={28} color="#0A0A0C" /></div>
                </div>
                <h1 style={portalStyles.title}>
                  Deutsch <span style={{ color: "#FF9F1C" }}>Akademie</span>
                </h1>
                <div style={portalStyles.titleRule} />
                <p style={portalStyles.tagline}>Alman dilini Azərbaycan dilində öyrənənlər üçün</p>
                {streak > 0 && <div style={portalStyles.streakBadge}>🔥 {streak} gündür ardıcıl buradasan</div>}
              </div>
            </Reveal>

            <Reveal delay={0.05}>
              <section style={portalStyles.section}>
                <h2 style={portalStyles.h2}>Haqqımızda</h2>
                <p style={portalStyles.body}>
                  Deutsch Akademie — Azərbaycanlı öyrənənlər üçün Goethe, TestDaF və telc kimi
                  beynəlxalq imtahanların strukturuna uyğun hazırlanmış alman dili tədris materialları
                  və test kitabları yaradır. Məqsədimiz alman dilini aydın izahlarla, praktik
                  məşqlərlə hər kəsə əlçatan etməkdir.
                </p>
              </section>
            </Reveal>

            <Reveal delay={0.1}>
              <section style={portalStyles.section}>
                <h2 style={portalStyles.h2}>Fəaliyyətimiz</h2>
                <div style={portalStyles.grid}>
                  <TiltCard onClick={() => setView("lessons")} style={{ ...portalStyles.card, cursor: "pointer", textAlign: "left" }}>
                    <div style={portalStyles.cardIcon}>📚</div>
                    <h3 style={portalStyles.cardTitle}>Dərslər</h3>
                    <p style={portalStyles.cardText}>A1-dən B2-yə qədər səviyyələr üzrə qrammatika izahları.</p>
                  </TiltCard>
                  <TiltCard onClick={() => setView("dictionary")} style={{ ...portalStyles.card, cursor: "pointer", textAlign: "left" }}>
                    <div style={portalStyles.cardIcon}>📖</div>
                    <h3 style={portalStyles.cardTitle}>Lüğət</h3>
                    <p style={portalStyles.cardText}>Mövzulara görə qruplaşdırılmış alman-azərbaycan lüğəti.</p>
                  </TiltCard>
                  <TiltCard onClick={onStart} style={{ ...portalStyles.card, ...portalStyles.cardCta, cursor: "pointer", textAlign: "left" }}>
                    <div style={portalStyles.cardIcon}>🥨</div>
                    <h3 style={portalStyles.cardTitle}>Özünü Yoxla</h3>
                    <p style={portalStyles.cardText}>Onlayn testlə biliyini ölç, səviyyəni müəyyənləşdir.</p>
                    <div style={portalStyles.ctaLink}>Testə başla <ChevronRight size={16} /></div>
                  </TiltCard>
                  <TiltCard onClick={() => setView("courses")} style={{ ...portalStyles.card, cursor: "pointer", textAlign: "left" }}>
                    <div style={portalStyles.cardIcon}>🎓</div>
                    <h3 style={portalStyles.cardTitle}>Kurslar</h3>
                    <p style={portalStyles.cardText}>Müəllim rəhbərliyi ilə qruplarda alman dili kursları.</p>
                  </TiltCard>
                </div>
              </section>
            </Reveal>
          </>
        )}

        {view === "lessons" && <Reveal><LessonsView topicsByLevel={topicsByLevel} /></Reveal>}

        {view === "dictionary" && <Reveal><DictionaryView /></Reveal>}

        {view === "courses" && (
          <Reveal>
          <section style={portalStyles.section}>
            <h2 style={portalStyles.h2}>Kurslar</h2>
            <div style={portalStyles.grid}>
              {LEVELS.map((lvl) => (
                <div key={lvl} style={portalStyles.card}>
                  <h3 style={portalStyles.cardTitle}>{lvl} Kursu</h3>
                  <p style={portalStyles.cardText}>Qrup dərsləri, həftədə 2 dəfə. Cədvəl və qiymət üçün əlaqə saxla.</p>
                </div>
              ))}
            </div>

            <h2 style={{ ...portalStyles.h2, marginTop: 32 }}>Qeydiyyat</h2>
            {regSent ? (
              <p style={{ ...portalStyles.body, color: "#00D9A3" }}>Təşəkkürlər, {regForm.name}! Qeydiyyatın qeydə alındı, tezliklə əlaqə saxlayacağıq.</p>
            ) : (
              <div style={{ display: "grid", gap: 12, maxWidth: 360 }}>
                <input placeholder="Adın" value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} style={portalStyles.input} />
                <input placeholder="Telefon" value={regForm.phone} onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })} style={portalStyles.input} />
                <select value={regForm.course} onChange={(e) => setRegForm({ ...regForm, course: e.target.value })} style={portalStyles.input}>
                  {LEVELS.map((l) => <option key={l} value={l}>{l} Kursu</option>)}
                </select>
                <button onClick={() => {
                  if (!regForm.name) return;
                  sbInsert("course_registrations", { name: regForm.name, phone: regForm.phone, course: regForm.course }).catch(() => {});
                  setRegSent(true);
                }} style={portalStyles.primaryBtn}>Qeydiyyatdan keç</button>
              </div>
            )}
          </section>
          </Reveal>
        )}

        {view === "contact" && (
          <Reveal>
          <section style={portalStyles.section}>
            <h2 style={portalStyles.h2}>Əlaqə</h2>
            <p style={portalStyles.body}>
              Suallarınız üçün bizimlə əlaqə saxlaya bilərsiniz.<br /><br />
              📧 E-poçt: info@deutschakademie.az<br />
              📱 Telefon: +994 XX XXX XX XX<br />
              📍 Bakı, Azərbaycan
            </p>
          </section>
          </Reveal>
        )}

        <footer style={portalStyles.footer}>© 2026 Asim Alirzayev — Deutsch Akademie</footer>
      </div>
    </div>
  );
}

const portalStyles = {
  page: {
    minHeight: "100vh", position: "relative", overflow: "hidden",
    background: "linear-gradient(160deg, #0A0A0C 0%, #141416 100%)",
    fontFamily: "'Inter', -apple-system, sans-serif", color: "#F7F1E6",
  },
  cursorGlow: { position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" },
  bigShape: {
    position: "absolute", width: 520, height: 520, opacity: 0.22, filter: "blur(2px)", pointerEvents: "none",
    clipPath: "polygon(30% 0%, 100% 0%, 70% 100%, 0% 100%)",
  },
  bigShapeOutline: {
    position: "absolute", bottom: "-10%", left: "-6%", width: 340, height: 340, opacity: 0.5, pointerEvents: "none",
    border: "1.5px solid rgba(255,159,28,0.35)", transform: "rotate(12deg)",
  },
  blob: { position: "absolute", width: 380, height: 380, borderRadius: "50%", filter: "blur(85px)", opacity: 0.45, pointerEvents: "none" },
  angular: { position: "absolute", width: 130, height: 130, opacity: 0.28, filter: "blur(1px)", pointerEvents: "none", clipPath: "polygon(20% 0%, 100% 0%, 80% 100%, 0% 100%)" },
  angularOutline: { position: "absolute", width: 80, height: 80, border: "2px solid rgba(0,217,163,0.4)", opacity: 0.6, pointerEvents: "none" },
  content: { position: "relative", zIndex: 1, maxWidth: 780, margin: "0 auto", padding: "8px 20px 40px" },
  hero: { textAlign: "center", padding: "48px 0 44px" },
  emblem: { display: "flex", justifyContent: "center", marginBottom: 18 },
  emblemRing: {
    width: 64, height: 64, borderRadius: "50%", background: "linear-gradient(135deg, #FF9F1C, #FFD580)",
    display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 4px rgba(255,159,28,0.2)",
  },
  title: { fontFamily: "'Fraunces', serif", fontSize: 52, margin: 0, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1.05 },
  titleRule: { width: 64, height: 3, background: "#FF9F1C", margin: "20px auto 0" },
  tagline: { opacity: 0.65, fontSize: 15, marginTop: 18, letterSpacing: 0.3 },
  streakBadge: { display: "inline-block", marginTop: 16, padding: "6px 14px", borderRadius: 999, background: "rgba(255,159,28,0.12)", border: "1px solid rgba(255,159,28,0.3)", fontSize: 12.5 },
  section: { marginBottom: 40 },
  h2: { fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: "#F7F1E6", marginBottom: 14, letterSpacing: -0.5 },
  body: { lineHeight: 1.7, fontSize: 15.5, opacity: 0.75 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 },
  card: {
    position: "relative", overflow: "hidden", background: "rgba(255,255,255,0.035)", border: "1px solid rgba(247,241,230,0.12)",
    borderRadius: 4, padding: 24,
  },
  tiltGlow: {
    position: "absolute", inset: 0, opacity: 0, pointerEvents: "none",
    background: "radial-gradient(180px circle at var(--gx,50%) var(--gy,50%), rgba(255,159,28,0.15), transparent 70%)",
    transition: "opacity .2s",
  },
  cardCta: { border: "1px solid rgba(255,159,28,0.6)", background: "rgba(255,159,28,0.07)" },
  cardIcon: { fontSize: 24, marginBottom: 12 },
  cardTitle: { fontFamily: "'Fraunces', serif", fontSize: 17, fontWeight: 700, margin: "0 0 8px", position: "relative" },
  cardText: { fontSize: 13.5, opacity: 0.7, lineHeight: 1.5, margin: 0, position: "relative" },
  ctaLink: { display: "flex", alignItems: "center", gap: 4, marginTop: 12, color: "#FF9F1C", fontSize: 13.5, fontWeight: 700, position: "relative" },
  footer: { textAlign: "center", opacity: 0.4, fontSize: 12.5, marginTop: 20 },
  nav: {
    position: "relative", zIndex: 2, display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "18px 24px", flexWrap: "wrap", gap: 12, borderBottom: "1px solid rgba(247,241,230,0.08)",
  },
  navBrand: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
  navEmblem: { width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,#FF9F1C,#FFD580)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  navBrandText: { fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 700, letterSpacing: -0.3 },
  navLinks: { display: "flex", gap: 2, flexWrap: "wrap" },
  navLink: { background: "none", border: "none", color: "rgba(247,241,230,0.6)", fontSize: 13.5, padding: "8px 12px", borderRadius: 4, cursor: "pointer" },
  navLinkActive: { background: "rgba(255,159,28,0.14)", color: "#FF9F1C", fontWeight: 700 },
  pill: { padding: "8px 18px", borderRadius: 4, border: "1px solid rgba(247,241,230,0.2)", background: "transparent", color: "#F7F1E6", cursor: "pointer", fontSize: 14 },
  pillActive: { background: "#FF9F1C", color: "#0A0A0C", fontWeight: 700, borderColor: "#FF9F1C" },
  input: { width: "100%", padding: "12px 14px", borderRadius: 4, border: "1px solid rgba(247,241,230,0.2)", background: "rgba(255,255,255,0.04)", color: "#F7F1E6", fontSize: 14.5, boxSizing: "border-box" },
  primaryBtn: { background: "#FF9F1C", color: "#0A0A0C", border: "none", borderRadius: 4, padding: "12px 22px", fontWeight: 700, fontSize: 14.5, cursor: "pointer" },
  lessonCard: { background: "rgba(255,255,255,0.035)", border: "1px solid rgba(247,241,230,0.12)", borderRadius: 4, overflow: "hidden" },
  lessonHeader: { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", color: "#F7F1E6", padding: "14px 16px", fontSize: 14.5, cursor: "pointer", textAlign: "left" },
  lessonBody: {
    whiteSpace: "pre-wrap", fontFamily: "'Inter', sans-serif", fontSize: 13.5, lineHeight: 1.7,
    padding: "0 16px 18px", margin: 0, opacity: 0.85, borderTop: "1px solid rgba(247,241,230,0.08)", paddingTop: 14,
  },
  lessonBodyWrap: {},
  vocabBox: { margin: "0 16px 18px", padding: 16, background: "rgba(255,159,28,0.06)", border: "1px solid rgba(255,159,28,0.25)", borderRadius: 4 },
  vocabTitle: { fontSize: 13, fontWeight: 700, color: "#FF9F1C" },
  dictRow: { background: "rgba(255,255,255,0.035)", borderRadius: 4, padding: "10px 14px", borderLeft: "3px solid #FF9F1C" },
  dictTerm: { fontWeight: 700, fontSize: 14.5 },
  dictTrans: { fontSize: 13, opacity: 0.7, marginTop: 2 },
};

function Shell({ children, wide }) {
  return (
    <div style={{ ...styles.page }}>
      <style>{`
        button {
          -webkit-tap-highlight-color: transparent;
          -webkit-appearance: none;
          appearance: none;
          outline: none;
        }
        button:focus, button:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(201,161,90,0.45);
        }
        textarea, input {
          -webkit-tap-highlight-color: transparent;
        }
      `}</style>
      <div style={{ ...styles.container, maxWidth: wide ? 640 : 460 }}>{children}</div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0F1B33 0%, #17264A 100%)",
    color: "#F5EFE0",
    fontFamily: "'Inter', -apple-system, sans-serif",
    display: "flex",
    justifyContent: "center",
    padding: "32px 16px",
  },
  container: { width: "100%" },
  h1: { fontFamily: "'Fraunces', serif", fontSize: 34, margin: 0, fontWeight: 600 },
  h2: { fontFamily: "'Fraunces', serif", fontSize: 24, marginBottom: 4 },
  h3: { fontFamily: "'Fraunces', serif", fontSize: 17, color: "#C9A15A", marginBottom: 10 },
  sub: { opacity: 0.75, fontSize: 14, marginTop: 4 },
  label: { fontSize: 13, opacity: 0.8, marginBottom: 6, display: "block" },
  input: {
    width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(201,161,90,0.3)",
    background: "rgba(255,255,255,0.05)", color: "#F5EFE0", fontSize: 15, outline: "none", boxSizing: "border-box",
  },
  card: {
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(201,161,90,0.25)", borderRadius: 12,
    padding: "16px 14px", color: "#F5EFE0", cursor: "pointer", textAlign: "left",
  },
  cardActive: { borderColor: "#C9A15A", background: "rgba(201,161,90,0.12)" },
  cardGold: { background: "rgba(201,161,90,0.15)", borderColor: "#C9A15A" },
  pill: {
    padding: "8px 18px", borderRadius: 999, border: "1px solid rgba(201,161,90,0.3)",
    background: "transparent", color: "#F5EFE0", cursor: "pointer",
  },
  pillActive: { background: "#C9A15A", color: "#0F1B33", fontWeight: 600, borderColor: "#C9A15A" },
  primaryBtn: {
    background: "#C9A15A", color: "#0F1B33", border: "none", borderRadius: 10, padding: "12px 22px",
    fontWeight: 600, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, justifyContent: "center",
  },
  secondaryBtn: {
    background: "transparent", color: "#F5EFE0", border: "1px solid rgba(245,239,224,0.3)", borderRadius: 10,
    padding: "12px 22px", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
  },
  backBtn: { background: "none", border: "none", color: "#C9A15A", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginBottom: 14, fontSize: 14, padding: 0 },
  testHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14 },
  exitBtn: { background: "none", border: "none", color: "rgba(245,239,224,0.6)", display: "flex", alignItems: "center", gap: 2, cursor: "pointer", fontSize: 13, padding: 0 },
  progressTrack: { height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 4, marginTop: 10 },
  progressFill: { height: 4, background: "#C9A15A", borderRadius: 4, transition: "width .3s" },
  question: { fontSize: 19, marginBottom: 18, lineHeight: 1.5 },
  option: {
    padding: "13px 16px", borderRadius: 10, border: "1px solid rgba(245,239,224,0.2)", background: "rgba(255,255,255,0.04)",
    color: "#F5EFE0", textAlign: "left", cursor: "pointer", fontSize: 15,
  },
  optionActive: { borderColor: "#C9A15A", background: "rgba(201,161,90,0.18)" },
  textarea: {
    width: "100%", minHeight: 90, padding: 12, borderRadius: 10, border: "1px solid rgba(201,161,90,0.3)",
    background: "rgba(255,255,255,0.05)", color: "#F5EFE0", fontSize: 15, boxSizing: "border-box", fontFamily: "inherit",
  },
  statRow: { display: "flex", alignItems: "center", gap: 10 },
  statTrack: { flex: 1, height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 8, overflow: "hidden" },
  statFill: { height: 8, borderRadius: 8 },
  reviewRow: { background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "8px 12px" },
  adBox: { background: "rgba(201,161,90,0.08)", border: "1px solid rgba(201,161,90,0.25)", borderRadius: 12, padding: 18 },
};
