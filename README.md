# Servidor de la Plataforma Educativa

Backend que le da vida real a la IA del prototipo:

- **IA real** vía NVIDIA NIM (build.nvidia.com): gratis, sin cobro por tokens.
  Endpoint OpenAI-compatible. Modelo por defecto: `google/gemma-4-31b-it`
  (cambiá `NVIDIA_MODEL` en `.env`). Sin API key, la app cae a modo demo automáticamente.
- **RAG**: busca en los apuntes de la materia más relevantes a la pregunta
  (ranking por solapamiento de palabras) y se los pasa a la IA como contexto.
- **Fuentes académicas**: consulta la API gratuita de Semantic Scholar y las
  usa como citas verificables en cada respuesta.

## Cómo correrlo

```bash
cd servidor
npm install
```

Creá tu archivo `.env` (copiá `.env.example` y pegá tu `NVIDIA_API_KEY` de
https://build.nvidia.com).

```bash
npm start
```

Abrí http://localhost:3000

El servidor sirve todo el prototipo (index.html + assets) y expone
`POST /api/chat`.

## Cómo funciona /api/chat

Body: `{ pregunta, materiaNombre, materiales[], historial[] }`

1. Rankea los materiales de la materia (viene del front).
2. Busca hasta 3 papers reales en Semantic Scholar sobre el tema.
3. Arma el prompt con la filosofía de la plataforma (no resolver tareas,
   citar fuentes, no inventar) y llama a NVIDIA.
4. Devuelve `{ texto, conceptos[], fuentes[] }`.

Si no hay clave o la API falla, devuelve `{ usarDemo: true }` y el front
usa el motor local (ai.js) para que la demo nunca se rompa.

## Nota sobre "Google Académico"

Google Scholar no expone una API oficial para este uso, así que las citas
académicas salen de **Semantic Scholar** (índice académico abierto) y quedan
etiquetadas en la UI como fuentes académicas. Misma idea, datos reales.