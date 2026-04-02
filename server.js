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

// --- ESTADOS GLOBAIS ---
let ultima_analise_ia = "Link neural em standby. Aguardando uplink...";
let comando_led = false; // A Matriz agora controla o LED

const groq = new Groq({ 
    apiKey: "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" 
});

// AQUI VOCÊ VAI COLOCAR OS DADOS DO BANCO DA NUVEM DEPOIS
// --- CONEXÃO COM O BANCO DE DADOS (NUVEM - AIVEN) ---
// Substitua a string abaixo pela sua "Service URI" copiada do Aiven
const uri_aiven = "mysql://avnadmin:AVNS_ve_Ovl6MuOzWmiWYOwbmysql-15ef5ed3-thiagolsk8-8d2b.b.aivencloud.com:10432/defaultdb?ssl-mode=REQUIRED";

const db = mysql.createConnection(uri_aiven);

db.connect(err => {
    if (err) {
        console.error('❌ [ERRO] Falha crítica no MySQL Cloud:', err.message);
        return;
    }
    console.log('✅ [SISTEMA] Banco de Dados ORBITAL (Aiven) Sincronizado.');
});
});

// --- ROTA FRONT-END: O SITE PRINCIPAL ---
app.get('/', (req, res) => {
    res.send(getHtmlContent());
});

// --- ROTA DE UPLINK (ESP32 ENVIA DADOS) ---
app.post('/api/dados', async (req, res) => {
    const { temperatura, umidade } = req.body;
    const sql = 'INSERT INTO leituras (temperatura, umidade) VALUES (?, ?)';
    
    db.query(sql, [temperatura, umidade], async (err, result) => {
        if (err) return res.status(500).send('Erro no banco');

        console.log(`📡 [UPLINK] Temp: ${temperatura}°C | Umid: ${umidade}%`);

        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: "Você é a IA Matriz ARES v5. Estilo cyberpunk militar. Responda em PT-BR com max 10 palavras." },
                    { role: "user", content: `STATUS: Temp ${temperatura}°C, Umid ${umidade}%. Analisar.` }
                ],
                model: "llama-3.3-70b-versatile",
            });
            ultima_analise_ia = chatCompletion.choices[0].message.content.trim();
            console.log(`🤖 [IA]: ${ultima_analise_ia}`);
            res.status(200).send(ultima_analise_ia);
        } catch (error) {
            ultima_analise_ia = "Conexão Neural Instável. Monitoramento passivo.";
            res.status(200).send(ultima_analise_ia);
        }
    });
});

// --- ROTA DE DADOS DO DASHBOARD ---
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

// --- ROTAS DE COMANDO DO LED ---
// O site chama essa rota para mudar o estado
app.get('/api/led', (req, res) => {
    comando_led = req.query.state === 'on';
    console.log(`💡 OVERRIDE SOLICITADO: LED -> ${comando_led ? 'ON' : 'OFF'}`);
    res.send("OK");
});

// O ESP32 chama essa rota para perguntar "Devo ligar?"
app.get('/api/comando_led', (req, res) => {
    res.json({ led: comando_led });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n MATRIZ OPERACIONAL - PORTA ${PORT} `);
});

// --- O SEU CÓDIGO HTML AGORA FICA AQUI ---
function getHtmlContent() {
    return `
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>ARES v5 - NUVEM</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <style>
        body { background-color: #050505; color: #00ffcc; font-family: 'Share Tech Mono', monospace; display: flex; flex-direction: column; align-items: center; padding: 20px; background-image: linear-gradient(rgba(0, 255, 204, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 204, 0.05) 1px, transparent 1px); background-size: 20px 20px; }
        h1 { color: #ff00ea; text-shadow: 0 0 10px #ff00ea; }
        .container { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; max-width: 900px; width: 100%; margin-top: 20px; }
        .card { background: rgba(10, 10, 10, 0.8); padding: 20px; border: 1px solid #00ffcc; text-align: center; flex: 1; min-width: 200px; }
        .val { font-size: 2.8em; margin: 10px 0; }
        .chart-container { width: 100%; max-width: 850px; background: rgba(10, 10, 10, 0.8); padding: 20px; border: 1px solid #30363d; margin-top: 20px; }
        .ai-quote { margin-top: 20px; max-width: 850px; width: 100%; color: #fce803; border-left: 4px solid #fce803; padding: 15px; background: rgba(252, 232, 3, 0.05); font-size: 1.2em; }
        button { background: transparent; color: #ff00ea; border: 1px solid #ff00ea; padding: 12px 28px; cursor: pointer; margin: 0 10px; }
        button:hover { background: #ff00ea; color: #000; box-shadow: 0 0 15px #ff00ea; }
    </style></head><body>

    <h1>[ ARES v5 // CLOUD MATRIZ ]</h1>
    <div class="container">
        <div class="card"><div style="color: #666;">[ TEMP ]</div><div id="t" class="val" style="color: #ff00ea;">--.-°C</div></div>
        <div class="card"><div style="color: #666;">[ UMID ]</div><div id="u" class="val">--%</div></div>
    </div>
    <div class="ai-quote" id="ai-text">> Aguardando IA...</div>
    <div class="chart-container"><canvas id="mainChart" height="120"></canvas></div>
    <div style="margin-top: 25px;">
        <button onclick="f('on')">LED ON</button>
        <button onclick="f('off')">LED OFF</button>
    </div>

    <script>
        Chart.defaults.color = '#00ffcc';
        const ctx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [
                { label: 'TEMP (°C)', data: [], borderColor: '#ff00ea', tension: 0.1 },
                { label: 'UMID (%)', data: [], borderColor: '#00ffcc', tension: 0.1, yAxisID: 'y1' }
            ]},
            options: { scales: { y: { position: 'left' }, y1: { position: 'right' } } }
        });

        function update() {
            // Agora o site busca os dados na mesma URL onde ele está hospedado!
            fetch('/api/data').then(r => r.json()).then(d => {
                document.getElementById('t').innerText = d.temp.toFixed(1) + '°C';
                document.getElementById('u').innerText = d.umid.toFixed(0) + '%';
                if(d.ia_msg) document.getElementById('ai-text').innerText = '> ' + d.ia_msg;

                const now = new Date().toLocaleTimeString();
                if(chart.data.labels.length > 20) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); chart.data.datasets[1].data.shift(); }
                chart.data.labels.push(now); chart.data.datasets[0].data.push(d.temp); chart.data.datasets[1].data.push(d.umid);
                chart.update('none'); 
            }).catch(e => console.log("Erro de conexão com a Matriz"));
        }
        function f(s) { fetch('/api/led?state=' + s); }
        setInterval(update, 2000); update();
    </script></body></html>`;
}
