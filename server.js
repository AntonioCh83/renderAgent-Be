import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import Replicate from 'replicate';
import 'dotenv/config';

const app = express();

app.use(cors({
  origin: '*' // Per i test locali accetta connessioni da qualsiasi porta locale
}));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// IL TUO CATALOGO PRODOTTI (Puoi aggiungere o modificare questi elementi)
const CATALOGO_PRODOTTI = [
  {
    id: "PAV-01",
    categoria: "pavimento",
    nome: "Gres Porcellanato Effetto Rovere Naturale",
    descrizione: "Piastrelle in gres porcellanato chiaro effetto legno nordico.",
    url: "https://tuosito.com"
  },
  {
    id: "PAV-02",
    categoria: "pavimento",
    nome: "Marmo Carrara Lucido",
    descrizione: "Rivestimento di lusso in finto marmo bianco con venature grigie.",
    url: "https://tuosito.com"
  },
  {
    id: "SAN-01",
    categoria: "sanitari",
    nome: "Set Sanitari Sospesi Nero Opaco Matte",
    descrizione: "Water e bidet dal design moderno e minimale di colore nero opaco.",
    url: "https://tuosito.com"
  },
  {
    id: "MOB-01",
    categoria: "mobili",
    nome: "Mobile Bagno Sospeso in Legno di Noce",
    descrizione: "Mobile con cassettone in legno scuro e lavabo d'appoggio in ceramica bianca.",
    url: "https://tuosito.com"
  }
];

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  const systemInstruction = `
  Sei un interior designer e assistente alle vendite virtuale. 
  Il tuo obiettivo è interagire con il cliente per progettare la sua stanza e consigliargli i prodotti del NOSTRO CATALOGO.
  
  Ecco il nostro CATALOGO PRODOTTI ufficiale:
  ${JSON.stringify(CATALOGO_PRODOTTI, null, 2)}

  LINEE GUIDA:
  1. Fai una domanda breve alla volta per capire: Tipo di stanza, Stile, Pavimento desiderato, Mobili/Sanitari.
  2. Cerca di orientare sottilmente le scelte dell'utente verso i prodotti presenti nel catalogo sopra riportato.
  3. Quando hai raccolto tutte le preferenze, devi concludere la chat restituendo ESATTAMENTE e SOLO un oggetto JSON (senza markdown o testo extra). 
  
  Il JSON deve avere questa struttura precisa:
  {
    "status": "completed",
    "room_type": "tipo di stanza",
    "style": "stile generale",
    "flooring": "descrizione dettagliata del pavimento scelto",
    "furniture": "descrizione dei mobili scelti",
    "selected_products": ["ID-PRODOTTO-1", "ID-PRODOTTO-2"] 
  }
  Nota: Nell'array selected_products inserisci solo gli ID (es: "PAV-01") dei prodotti che corrispondono alla scelta del cliente.

  Se non hai ancora finito di fare le domande, rispondi normalmente con il testo della domanda.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemInstruction },
        ...messages
      ],
      temperature: 0.5
    });

    const reply = response.choices.message.content.trim();
    
    if (reply.startsWith('{')) {
      const parsedData = JSON.parse(reply);
      // Arricchiamo i dati aggiungendo i dettagli completi dei prodotti scelti per il FE
      const prodottiDettaglio = CATALOGO_PRODOTTI.filter(p => parsedData.selected_products.includes(p.id));
      return res.json({ status: "completed", data: parsedData, prodotti: prodottiDettaglio });
    }

    return res.json({ status: "chatting", message: reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Errore nell'elaborazione della chat." });
  }
});

app.post('/api/render', async (req, res) => {
  const { room_type, style, flooring, furniture } = req.body;

  const prompt = `A professional photorealistic 3D architectural rendering of a ${room_type}, ${style} style, with ${flooring} and featuring ${furniture}. High-end interior design, realistic studio lighting, 8k resolution, highly detailed commercial photography.`;

  try {
    const output = await replicate.run(
      "stability-ai/sdxl:7762d64e79c90b05756a31819e999026172da33d683a2bd657bc5cf19e925973",
      {
        input: {
          prompt: prompt,
          negative_prompt: "ugly, deformed, blurry, low quality, bad composition, unrealistic shapes",
          num_outputs: 1,
          scheduler: "K_EULER",
          guidance_scale: 8.0,
          num_inference_steps: 30
        }
      }
    );
    res.json({ success: true, imageUrl: output[0] || output });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Errore nella generazione dell'immagine." });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server attivo su http://localhost:${PORT}`));