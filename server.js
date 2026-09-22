require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_VISION_MODEL = process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
const NVIDIA_KEY = process.env.NVIDIA_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";

app.use(express.static(path.join(__dirname, "..")));

app.get("/api/health", (req, res) => {
  const proveedor = GROQ_KEY ? "Groq" : NVIDIA_KEY ? "NVIDIA" : "demo";
  res.json({ ok: true, iaReal: !!(GROQ_KEY || NVIDIA_KEY), proveedor });
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

/* Llama al LLM de texto: Groq (rápido) si hay key, sino NVIDIA. Si el primero falla, prueba el otro. */
async function llamarIA(systemMsg, userMsg) {
  const proveedores = [];
  if (GROQ_KEY) proveedores.push({ nombre: "Groq", url: GROQ_URL, key: GROQ_KEY, model: GROQ_MODEL });
  if (NVIDIA_KEY) proveedores.push({ nombre: "NVIDIA", url: NVIDIA_URL, key: NVIDIA_KEY, model: NVIDIA_MODEL });
  if (!proveedores.length) throw new Error("Sin API key configurada");
  let ultimoError = null;
  for (const prov of proveedores) {
    try {
      return await llamarProveedor(prov, systemMsg, userMsg);
    } catch (e) {
      ultimoError = e;
      console.error(`Fallo ${prov.nombre}:`, e.message);
    }
  }
  throw ultimoError || new Error("Todos los proveedores fallaron");
}

async function llamarProveedor(prov, systemMsg, userMsg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(prov.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${prov.key}`,
      },
      body: JSON.stringify({
        model: prov.model,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(prov.nombre + " API error " + res.status);
  const data = await res.json();
  const texto = data.choices?.[0]?.message?.content || "";
  return texto.trim();
}

/* Interpreta una imagen (base64 sin prefijo "data:") usando un modelo de visión. */
async function describirImagen(base64, mime) {
  const dataUrl = "data:" + (mime || "image/jpeg") + ";base64," + base64;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NVIDIA_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_VISION_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Sos una IA educativa para estudiantes de secundaria. Describí esta imagen en detalle como si la estuvieras explicando a un alumno: qué contiene, qué concepto o tema se ve, y qué puntos clave debería recordar. Respondé en español de Argentina, directo y breve." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error("Vision API error " + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

const FILOSOFIA =
  "Sos una IA de apoyo al estudio en una plataforma educativa para estudiantes de secundaria. Reglas de oro: " +
  "1) Nunca resolver la tarea por el estudiante: guiarlo paso a paso, pedirle que muestre su proceso y corregirlo. " +
  "2) El material del estudiante y las fuentes academicas se usan como refuerzo, NO como barrera: si la pregunta es de conocimiento academico general o trivial (matematica basica, definiciones estandar, datos universales), respondela con normalidad y sin negarte. Solo decilo 'No puedo confirmar esto' si es algo especifico del material que no esta en las fuentes y no podes verificar. " +
  "3) Responder siempre en español de Argentina, directo y amigable. " +
  "4) Texto breve: maximo 2-3 parrafos o pasos numerados cortos.";

app.post("/api/chat", async (req, res) => {
  const { pregunta, materiaNombre, materiales, historial, adjuntos } = req.body || {};

  if (!GROQ_KEY && !NVIDIA_KEY) {
    return res.json({ usarDemo: true });
  }

  try {
    /* 1) Adjuntos: interpretar imágenes con visión y armar bloque de contexto */
    let bloqueAdjuntos = "";
    if (Array.isArray(adjuntos) && adjuntos.length) {
      const descripciones = [];
      for (const adj of adjuntos.slice(0, 3)) {
        if (adj.tipo === "imagen" && adj.base64) {
          try {
            const desc = await describirImagen(adj.base64, adj.mime);
            descripciones.push(`[Imagen adjunta "${adj.nombre || "imagen"}"] Descripcion: ${desc}`);
          } catch (e) {
            descripciones.push(`[Imagen adjunta "${adj.nombre || "imagen"}"] (no se pudo interpretar)`);
          }
        } else if (adj.tipo === "texto" && adj.texto) {
          descripciones.push(`[Archivo adjunto "${adj.nombre || "archivo"}"]\n${String(adj.texto).slice(0, 6000)}`);
        } else if ((adj.tipo === "pdf" || adj.tipo === "docx" || adj.tipo === "word") && adj.texto) {
          descripciones.push(`[Documento adjunto "${adj.nombre || "documento"}" extraido]\n${String(adj.texto).slice(0, 6000)}`);
        } else if (adj.texto) {
          descripciones.push(`[Archivo adjunto "${adj.nombre || "archivo"}"]\n${String(adj.texto).slice(0, 6000)}`);
        }
      }
      if (descripciones.length) {
        bloqueAdjuntos = "ADJUNTOS DEL ESTUDIANTE EN ESTE MENSAJE:\n" + descripciones.join("\n\n");
      }
    }

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
      ...(bloqueAdjuntos ? [bloqueAdjuntos, ``] : []),
      `PREGUNTA DEL ESTUDIANTE: ${pregunta}`,
      ``,
      `Al final de tu respuesta, en una linea aparte que empiece con FUENTES:, listar las fuentes que usaste (del material, los adjuntos o academicas) separadas por ' | '. Si ninguna es util o no encontraste, escribi: FUENTES: Material del estudiante`,
    ].join("\n");

    const historialMsg = (historial || [])
      .slice(-6)
      .map((h) => `${h.rol === "user" ? "Estudiante" : "IA"}: ${h.texto}`)
      .join("\n");

    const systemMsg = FILOSOFIA + "\n\nHistorial reciente:\n" + (historialMsg || "(sin historial)");

    const texto = await llamarIA(systemMsg, userMsg);

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

/* Genera un resumen real por IA: recibe la materia y sus materiales (o un texto pegado). */
app.post("/api/resumir", async (req, res) => {
  const { materiaId, materiaNombre, materiales, texto } = req.body || {};

  if (!GROQ_KEY && !NVIDIA_KEY) return res.json({ usarDemo: true });

  const fuenteTexto = Array.isArray(texto) && texto.length ? texto.join("\n") : String(texto || "");
  const fuenteMaterial = (Array.isArray(materiales) ? materiales : [])
    .filter(Boolean)
    .map((m, i) => `[Material ${i + 1}] ${String(m).slice(0, 3000)}`)
    .join("\n\n");
  const cuerpo = fuenteTexto || fuenteMaterial;
  if (!cuerpo.trim()) return res.json({ usarDemo: true, error: "Sin contenido para resumir" });

  try {
    const sysResumen =
      "Sos una IA de apoyo al estudio que genera resumenes claros para estudiantes de secundaria. " +
      "Devolveme el resumen del material que te paso, SIEMPRE en este formato exacto:\n" +
      "TEMA: <tema central>\n\n" +
      "IDEA CENTRAL: <1 oracion que resuma todo>\n\n" +
      "PUNTOS CLAVE:\n- <punto 1>\n- <punto 2>\n- <punto 3>\n\n" +
      "PARA RECORDAR: <consejo o concepto que no hay que olvidar>\n\n" +
      "No agregues nada fuera de este formato. Respondé en español de Argentina, directo.";

    const userMsg =
      `Materia: ${materiaNombre || materiaId || "General"}\n\n` +
      `MATERIAL A RESUMIR:\n${cuerpo.slice(0, 20000)}\n\nGenerá el resumen.`;

    const textoResumen = await llamarIA(sysResumen, userMsg);

    res.json({
      ok: true,
      usarDemo: false,
      resumen: textoResumen,
      materiaId: materiaId || null,
      materiaNombre: materiaNombre || null,
      usandoIA: true,
    });
  } catch (err) {
    console.error("Error en /api/resumir:", err.message);
    res.json({ usarDemo: true, error: err.message });
  }
});

/* Genera un quiz real por IA: recibe la materia y sus materiales, pide JSON a NVIDIA. */
app.post("/api/generar-quiz", async (req, res) => {
  const { materiaId, materiaNombre, materiales } = req.body || {};

  if (!GROQ_KEY && !NVIDIA_KEY) return res.json({ usarDemo: true });
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

    const texto = await llamarIA(sysQuiz, "MATERIAL:\n\n" + materialCtx + "\n\nGenerá el quiz JSON.");

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

/* Extrae el texto de un PDF (.pdf vía pdf-parse v2) o Word (.docx vía mammoth). */
app.post("/api/extraer-pdf", async (req, res) => {
  const { nombre, base64 } = req.body || {};
  if (!base64) return res.json({ usarDemo: true, error: "sin archivo" });

  try {
    let texto = "";
    if (!texto) texto = await extraerTextoArchivo(nombre, base64);
    texto = String(texto || "").slice(0, 30000).trim();
    if (!texto) {
      return res.json({
        usarDemo: true,
        error: "No se pudo extraer texto (¿PDF escaneado sin capa de texto, o formato Word viejo .doc? Probá .txt o .docx).",
      });
    }
    res.json({ ok: true, nombre: String(nombre || "apunte"), texto: texto });
  } catch (err) {
    console.error("Error en /api/extraer-pdf:", err.message);
    res.json({ usarDemo: true, error: err.message });
  }
});

async function extraerTextoArchivo(nombre, base64) {
  const buf = Buffer.from(base64, "base64");
  const n = String(nombre || "").toLowerCase();
  if (/\.pdf$/i.test(n)) {
    const { PDFParse } = require("pdf-parse");
    const pdf = new PDFParse({ data: buf });
    const data = await pdf.getText();
    return String(data.text || "");
  }
  if (/\.docx$/i.test(n)) {
    const mammoth = require("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return String(r.value || "");
  }
  if (/\.doc$/i.test(n)) {
    throw new Error("Formato Word viejo (.doc) no soportado: convertilo a .docx");
  }
  return String(base64); /* fallback: devolver la cadena base64 sin sentido */
}

app.listen(PORT, () => {
  console.log(`Plataforma educativa escuchando en http://localhost:${PORT}`);
  console.log(`IA real: ${GROQ_KEY ? "Groq (" + GROQ_MODEL + ")" : NVIDIA_KEY ? "NVIDIA (" + NVIDIA_MODEL + ")" : "sin API key -> modo demo"}`);
});