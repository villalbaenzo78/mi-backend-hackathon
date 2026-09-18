require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const pdfParse = require("pdf-parse");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_KEY = process.env.NVIDIA_API_KEY || "";
const SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";

app.use(express.static(path.join(__dirname, "..")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, iaReal: !!NVIDIA_KEY });
});

function normalizar(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function tokenizar(t) {
  return normalizar(t).split(/[^a-z0-9áéíóúñ]+/i).filter((w) => w.length > 2);
}

function rankearMateriales(materiales, pregunta) {
  const tokens = tokenizar(pregunta);
  return (materiales || [])
    .map((m) => {
      const texto = String(m || "");
      let score = 0;
      tokens.forEach((tok) => {
        if (normalizar(texto).includes(tok)) score += 1;
      });
      return { texto, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function buscarFuentesAcademicas(query) {
  const scholarly = await buscarSemanticScholar(query);
  if (scholarly.length) return scholarly;
  return buscarCrossref(query);
}

async function buscarSemanticScholar(query) {
  try {
    const q = encodeURIComponent(query.slice(0, 150));
    const res = await fetch(
      `${SCHOLAR_API}?query=${q}&limit=3&fields=title,url,year,authors`,
      { headers: { "User-Agent": "plataforma-educativa-hackathon" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .filter((p) => p.title && p.url)
      .map((p) => ({
        titulo: p.title,
        url: p.url,
        tipo: "Académica",
        anio: p.year || null,
        autores: (p.authors || []).slice(0, 3).map((a) => a.name).join(", "),
      }));
  } catch {
    return [];
  }
}

async function buscarCrossref(query) {
  try {
    const q = encodeURIComponent(query.slice(0, 150));
    const res = await fetch(
      `https://api.crossref.org/works?query=${q}&select=title,URL,issued,author&rows=3`,
      { headers: { "User-Agent": "plataforma-educativa-hackathon/1.0 (mailto:hackaton@local.ar)" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.message.items || [])
      .filter((p) => p.title && p.title.length && p.URL)
      .map((p) => ({
        titulo: p.title[0],
        url: p.URL,
        tipo: "Académica",
        anio: p.issued && p.issued["date-parts"] && p.issued["date-parts"][0] && p.issued["date-parts"][0][0] || null,
        autores: (p.author || []).slice(0, 3).map((a) => (a.given ? a.given + " " : "") + (a.family || "")).join(", "),
      }));
  } catch {
    return [];
  }
}

async function llamarNvidia(systemMsg, userMsg) {
  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NVIDIA_KEY}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      temperature: 0.3,
      max_tokens: 700,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) throw new Error("NVIDIA API error " + res.status);
  const data = await res.json();
  const texto = data.choices?.[0]?.message?.content || "";
  return texto.trim();
}

const FILOSOFIA =
  "Sos una IA de apoyo al estudio en una plataforma educativa para estudiantes de secundaria. Reglas de oro: " +
  "1) Nunca resolver la tarea por el estudiante: guiarlo paso a paso, pedirle que muestre su proceso y corregirlo. " +
  "2) El material del estudiante y las fuentes academicas se usan como refuerzo, NO como barrera: si la pregunta es de conocimiento academico general o trivial (matematica basica, definiciones estandar, datos universales), respondela con normalidad y sin negarte. Solo decilo 'No puedo confirmar esto' si es algo especifico del material que no esta en las fuentes y no podes verificar. " +
  "3) Responder siempre en español de Argentina, directo y amigable. " +
  "4) Texto breve: maximo 2-3 parrafos o pasos numerados cortos.";

app.post("/api/chat", async (req, res) => {
  const { pregunta, materiaNombre, materiales, historial } = req.body || {};

  if (!NVIDIA_KEY) {
    return res.json({ usarDemo: true });
  }

  try {
    const relevantes = rankearMateriales(materiales, pregunta);
    const contexto = relevantes.length
      ? relevantes.map((r, i) => `[Material ${i + 1}] ${r.texto.slice(0, 900)}`).join("\n\n")
      : "(No hay material del estudiante relevante para esta consulta.)";

    const academicas = await buscarFuentesAcademicas(pregunta);
    const fuentesAcad = academicas.length
      ? academicas.map((f) => `- ${f.titulo} (${f.anio || "s/f"}) · ${f.url}`).join("\n")
      : "(No se encontraron fuentes academicas adicionales.)";

    const userMsg = [
      `Materia del estudiante: ${materiaNombre || "General"}`,
      ``,
      `MATERIAL DEL ESTUDIANTE:\n${contexto}`,
      ``,
      `FUENTES ACADEMICAS DETECTADAS (podes citarlas si son utiles):\n${fuentesAcad}`,
      ``,
      `PREGUNTA DEL ESTUDIANTE: ${pregunta}`,
      ``,
      `Al final de tu respuesta, en una linea aparte que empiece con FUENTES:, listar las fuentes que usaste (del material o academicas) separadas por ' | '. Si ninguna es util o no encontraste, escribi: FUENTES: Material del estudiante`,
    ].join("\n");

    const historialMsg = (historial || [])
      .slice(-6)
      .map((h) => `${h.rol === "user" ? "Estudiante" : "IA"}: ${h.texto}`)
      .join("\n");

    const systemMsg = FILOSOFIA + "\n\nHistorial reciente:\n" + (historialMsg || "(sin historial)");

    const texto = await llamarNvidia(systemMsg, userMsg);

    let textosFuentes = [];
    const m = texto.match(/FUENTES:\s*(.+)$/s);
    const cuerpo = m ? texto.replace(/FUENTES:\s*.+$/s, "").trim() : texto;
    if (m) {
      textosFuentes = m[1].split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4);
    }
    const fuentes = [
      ...academicas.filter((f) => textosFuentes.some((tf) => normalizar(tf).includes(normalizar(f.titulo).slice(0, 25)) || normalizar(f.titulo).includes(normalizar(tf).slice(0, 25)))),
    ];
    const titulosFuentes = textosFuentes
      .filter((tf) => !fuentes.some((f) => normalizar(f.titulo).includes(normalizar(tf).slice(0, 25)) || normalizar(tf).includes(normalizar(f.titulo).slice(0, 25))))
      .map((tf) => (tf.startsWith("Material") || tf.includes("estudiante") ? { titulo: tf, url: null, tipo: "Material" } : { titulo: tf, url: null, tipo: "Académica" }));

    let fuentesFinal = [...fuentes, ...titulosFuentes].slice(0, 4);
    if (!fuentesFinal.length && academicas.length) {
      fuentesFinal = academicas.slice(0, 2);
    }
    fuentesFinal = fuentesFinal.filter((f, i, arr) => arr.findIndex((x) => x.titulo === f.titulo) === i);

    res.json({
      texto: cuerpo,
      conceptos: tokenizar(pregunta).slice(0, 4),
      fuentes: fuentesFinal,
      usandoIA: true,
    });
  } catch (err) {
    console.error("Error en /api/chat:", err.message);
    res.json({ usarDemo: true });
  }
});

/* Genera un quiz real por IA: recibe la materia y sus materiales, pide JSON a NVIDIA. */
app.post("/api/generar-quiz", async (req, res) => {
  const { materiaId, materiaNombre, materiales } = req.body || {};

  if (!NVIDIA_KEY) return res.json({ usarDemo: true });
  if (!Array.isArray(materiales) || !materiales.length) return res.json({ usarDemo: true });

  try {
    const materialCtx = materiales
      .slice(0, 3)
      .map((m, i) => `[Material ${i + 1}] ${String(m || "").slice(0, 1200)}`)
      .join("\n\n");

    const sysQuiz =
      FILOSOFIA + "\n\nGenerá un quiz de 4 preguntas de opción múltiple para la materia '" +
      (materiaNombre || materiaId || "General") +
      "', usando exclusivamente el material del estudiante. Respondé SOLO con JSON válido, sin texto fuera del JSON. Formato exacto:" +
      '\n[{"p":"pregunta","opciones":["a","b","c","d"],"correcta":INDICE_0_A_3,"explicacion":"breve explicacion"}, ...]' +
      "\nCada pregunta debe tener 4 opciones, una correcta (índice 0-3) y una explicación corta que refuerce el concepto.";

    const texto = await llamarNvidia(sysQuiz, "MATERIAL:\n\n" + materialCtx + "\n\nGenerá el quiz JSON.");

    /* Parseo robusto: extraer el primer array [ ... ] del texto */
    const ini = texto.indexOf("[");
    const fin = texto.lastIndexOf("]");
    if (ini === -1 || fin <= ini) return res.json({ usarDemo: true, error: "IA no devolvió JSON" });
    const candidatos = JSON.parse(texto.slice(ini, fin + 1));

    const preguntas = (Array.isArray(candidatos) ? candidatos : [candidatos])
      .filter((q) => q && q.p && Array.isArray(q.opciones) && q.opciones.length === 4 && typeof q.correcta === "number" && q.correcta >= 0 && q.correcta < 4)
      .slice(0, 4)
      .map((q) => ({
        p: String(q.p).trim(),
        opciones: q.opciones.map((o) => String(o).trim()),
        correcta: q.correcta,
        explicacion: String(q.explicacion || "").trim(),
      }));

    if (preguntas.length < 2) return res.json({ usarDemo: true, error: "IA devolvió preguntas inválidas" });
    res.json({ ok: true, usarDemo: false, preguntas });
  } catch (err) {
    console.error("Error en /api/generar-quiz:", err.message);
    res.json({ usarDemo: true, error: err.message });
  }
});

app.post("/api/extraer-pdf", async (req, res) => {
  const { nombre, base64 } = req.body || {};
  if (!base64) return res.json({ usarDemo: true, error: "sin archivo" });

  try {
    const buf = Buffer.from(base64, "base64");
    const data = await pdfParse(PDFParseOptionsPiper(buf));
    const texto = String(data.text || "").slice(0, 30000).trim();
    if (!texto) return res.json({ usarDemo: true, error: "PDF no tiene texto extraíble (puede ser escaneado)" });
    res.json({ ok: true, nombre: String(nombre || "apunte.pdf"), texto: texto });
  } catch (err) {
    console.error("Error en /api/extraer-pdf:", err.message);
    res.json({ usarDemo: true, error: err.message });
  }
});

function PDFParseOptionsPiper(buf) {
const pdfParse = require("pdf-parse");
  return buf; /* pdf-parse acepta Buffer directamente */
}

app.listen(PORT, () => {
  console.log(`Plataforma educativa escuchando en http://localhost:${PORT}`);
  console.log(`IA real: ${NVIDIA_KEY ? "CONECTADA (" + NVIDIA_MODEL + ")" : "sin API key -> modo demo"}`);
});