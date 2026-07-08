// Edge Function: estrai-cv
// Riceve un file PDF o DOCX, estrae il testo, e usa Groq per strutturarlo in JSON

import "npm:pdf-parse@1.1.1";
import mammoth from "npm:mammoth@1.6.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SCHEMA_CAMPI = `{
  "nome_cognome": "",
  "ruolo_desiderato": "",
  "citta": "",
  "email": "",
  "telefono": "",
  "presentazione_breve": "",
  "esperienze": [{"ruolo": "", "azienda": "", "periodo": "", "mansioni": ""}],
  "titolo_studio": "",
  "istituto": "",
  "anno_conseguimento": "",
  "competenze": ["", "", ""],
  "lingue": [{"nome": "", "livello": ""}],
  "patente_disponibilita": ""
}`;

const PROMPT_SISTEMA = `Sei un assistente che estrae informazioni da un CV e le restituisce SOLO come JSON valido, seguendo esattamente questo schema (usa stringa vuota "" o lista vuota [] se un'informazione non è presente, non inventare mai dati):

${SCHEMA_CAMPI}

Regole:
- Rispondi SOLO con il JSON, nessun testo prima o dopo, nessun blocco markdown.
- Il campo "esperienze" può contenere fino a 3 voci (le più recenti/rilevanti).
- Il campo "competenze" deve contenere al massimo 3 competenze tecniche principali.
- Il campo "lingue" deve contenere tutte le lingue trovate nel CV.`;

async function estraiTestoPdf(bytes: Uint8Array): Promise<string> {
  const pdfParse = (await import("npm:pdf-parse@1.1.1")).default;
  const data = await pdfParse(bytes);
  return data.text;
}

async function estraiTestoDocx(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "Nessun file ricevuto" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const nomeFile = file.name.toLowerCase();

    let testo = "";
    if (nomeFile.endsWith(".pdf")) {
      testo = await estraiTestoPdf(bytes);
    } else if (nomeFile.endsWith(".docx")) {
      testo = await estraiTestoDocx(bytes);
    } else {
      return new Response(JSON.stringify({ error: "Formato non supportato. Usa PDF o DOCX." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!testo || testo.trim().length < 20) {
      return new Response(JSON.stringify({ error: "Testo non estraibile dal file (potrebbe essere una scansione)." }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const groqApiKey = Deno.env.get("GROQ_API_KEY");
    if (!groqApiKey) {
      return new Response(JSON.stringify({ error: "Chiave Groq non configurata sul server." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: PROMPT_SISTEMA },
          { role: "user", content: `Testo del CV da analizzare:\n\n${testo.slice(0, 8000)}` },
        ],
        temperature: 0,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      return new Response(JSON.stringify({ error: "Errore Groq: " + errText }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const groqData = await groqResponse.json();
    let contenuto = groqData.choices[0].message.content.trim();

    if (contenuto.startsWith("```")) {
      contenuto = contenuto.replace(/```json|```/g, "").trim();
    }

    let datiEstratti;
    try {
      datiEstratti = JSON.parse(contenuto);
    } catch {
      return new Response(JSON.stringify({ error: "Risposta AI non valida" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(datiEstratti), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
