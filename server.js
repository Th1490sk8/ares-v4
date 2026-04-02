const express = require('express');
const mysql = require('mysql2');
const Groq = require('groq-sdk');

const app = express();

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.json());

let ultima_analise_ia = "Link neural em standby. Aguardando uplink...";
let comando_led = false; 

const groq = new Groq({ 
    apiKey: "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" 
});

// --- CONEXÃO COM O BANCO DE DADOS (NUVEM - AIVEN) ---
// Substitua o link abaixo pela sua URI completa do Aiven
const uri_aiven = "mysql://avnadmin:SUA_SENHA_AQUI@mysql-15ef5ed3-thiagolsk8-8d2b.b.aivencloud.com:10432/defaultdb?ssl-mode=REQUIRED";

const db = mysql.createConnection(uri_aiven);

db.connect(err => {
    if (err) {
        console.error('❌ [ERRO] Falha crítica no MySQL Cloud:', err.message);
        return;
    }
    console.log('✅ [SISTEMA] Banco de Dados ORBITAL Sincronizado.');
});

app.get('/', (req, res) => {
    res.send(getHtmlContent());
});

app.post('/api/dados', async (req, res) => {
    const { temperatura, umidade } = req.body;
    const sql = 'INSERT INTO leituras (temperatura, umidade) VALUES (?, ?)';
    
    db.query(sql, [temperatura, umidade], async (err, result) => {
        if (err) return res.status(500).send('Erro no banco');

        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: "Você é a IA Matriz ARES v5. Estilo cyberpunk militar. Responda em PT-BR com max 10 palavras." },
                    { role: "user", content: `STATUS: Temp ${temperatura}°C, Umid ${umidade}%. Analisar.` }
                ],
                model: "llama-3.3-70b-versatile",
            });
            ultima_analise_ia = chatCompletion.choices[0].message.content.trim();
            res.status(200).send(ultima_analise_ia);
        } catch (error) {
            ultima_analise_ia = "Conexão Neural Instável. Monitoramento passivo.";
            res.status(200).send(ultima_analise_ia);
        }
    });
});

app.get('/api/data', (req, res) => {
    const sql = 'SELECT temperatura, umidade FROM leituras ORDER BY id DESC LIMIT 1';
    db.query(sql, (err, results) => {
        let temp = 0, umid = 0;
        if (!err && results.length > 0) { temp = results[0].temperatura; umid = results[0].umidade; }
        res.json({
            temp: temp, umid: umid, ia_msg: ultima_analise_ia,
            led_state: comando_led, uptime: process.uptime().toFixed(0)
        });
    });
});

app.get('/api/led', (req, res) => {
    comando_led = req.query.state === 'on';
    res.send("OK");
});

app.get('/api/comando_led', (req, res) => {
    res.json({ led: comando_led });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MATRIZ OPERACIONAL NA PORTA ${PORT}`);
});

function getHtmlContent() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ARES v5 - CLOUD</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet"><style>body { background-color: #050505; color: #00ffcc; font-family: 'Share Tech Mono', monospace; display: flex; flex-direction: column; align-items: center; padding: 20px; } .card { background: rgba(10, 10, 10, 0.8); padding: 20px; border: 1px solid #00ffcc; text-align: center; margin: 10px; min-width: 200px; } .val { font-size: 2.8em; margin: 10px 0; color: #ff00ea; } button { background: transparent; color: #ff00ea; border: 1px solid #ff00ea; padding: 12px 28px; cursor: pointer; margin: 10px; font-family: inherit; } button:hover { background: #ff00ea; color: #000; } .ai-quote { color: #fce803; border-left: 4px solid #fce803; padding: 15px; background: rgba(252, 232, 3, 0.05); width: 80%; margin-top: 20px; }</style></head><body><h1>[ ARES v5 // CLOUD MATRIZ ]</h1><div style="display: flex;"><div class="card"><div>[ TEMP ]</div><div id="t" class="val">--.-°C</div></div><div class="card"><div>[ UMID ]</div><div id="u" class="val" style="color: #00ffcc;">--%</div></div></div><div class="ai-quote" id="ai-text">> Conectando à Matriz...</div><div style="margin-top: 25px;"><button onclick="f('on')">ATIVAR LED</button><button onclick="f('off')">DESATIVAR LED</button></div><script>function update() { fetch('/api/data').then(r => r.json()).then(d => { document.getElementById('t').innerText = d.temp.toFixed(1) + '°C'; document.getElementById('u').innerText = d.umid.toFixed(0) + '%'; document.getElementById('ai-text').innerText = '> ' + d.ia_msg; }).catch(e => console.error("Erro na busca")); } function f(s) { fetch('/api/led?state=' + s); } setInterval(update, 2000); update();</script></body></html>`;
}
