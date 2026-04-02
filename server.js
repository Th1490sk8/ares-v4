const express = require('express');
const mysql = require('mysql2');
const Groq = require('groq-sdk');

const app = express();

// --- SEGURANÇA E PARSER ---
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// --- ESTADOS GLOBAIS ---
let ultima_analise_ia = "Link neural em standby. Aguardando uplink...";
let comando_led = false; 

// 🛡️ MATRIZ BLINDADA: Chave da IA oculta
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY 
});

// 🛡️ MATRIZ BLINDADA: URL do Banco oculta
// Removemos a string que causa o aviso e ativamos o SSL nativo do Node
const uri_limpa = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace('?ssl-mode=REQUIRED', '') : '';
const db = mysql.createPool({
    uri: uri_limpa,
    ssl: { rejectUnauthorized: false } // Mantém a criptografia ativa sem irritar o mysql2
});

// Garantir Tabela
const queryCriarTabela = `
CREATE TABLE IF NOT EXISTS leituras (
    id INT AUTO_INCREMENT PRIMARY KEY,
    temperatura FLOAT NOT NULL,
    umidade FLOAT NOT NULL,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

db.query(queryCriarTabela, (err) => {
    if (err) console.error('❌ Erro na tabela:', err);
    else console.log('✅ Tabela "leituras" Sincronizada.');
});

// --- ROTAS DO SERVIDOR ---

app.get('/', (req, res) => {
    res.send(getHtmlContent());
});

// Recebe dados do ESP32
app.post('/api/dados', async (req, res) => {
    const { temperatura, umidade } = req.body;
    // CORREÇÃO 1: Grava no banco já com o horário de Brasília (-3h)
    const sql = 'INSERT INTO leituras (temperatura, umidade, data_hora) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR))';
    
    db.query(sql, [temperatura, umidade], async (err) => {
        if (err) {
            console.error('Erro no insert:', err);
            return res.status(500).send('Erro no banco');
        }
        
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
            ultima_analise_ia = "Conexão Neural Instável.";
            res.status(200).send(ultima_analise_ia);
        }
    });
});

// Dashboard consome esses dados
app.get('/api/data', (req, res) => {
    // CORREÇÃO 2: Lê a hora do banco sem fazer contas adicionais
    const sql = `SELECT temperatura, umidade, DATE_FORMAT(data_hora, '%H:%i:%s') as hora FROM leituras ORDER BY id DESC LIMIT 20`;
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Erro no select:', err);
            return res.status(500).json({ error: "Falha na leitura do banco" });
        }
        
        let temp = 0;
        let umid = 0;
        let historico = [];

        if (results && results.length > 0) {
            historico = results.reverse(); 
            temp = historico[historico.length - 1].temperatura;
            umid = historico[historico.length - 1].umidade;
        }

        res.json({ temp, umid, ia_msg: ultima_analise_ia, led_state: comando_led, historico });
    });
});

// Botões do site
app.get('/api/led', (req, res) => {
    comando_led = req.query.state === 'on';
    console.log(`💡 COMANDO LED -> ${comando_led ? 'ON' : 'OFF'}`);
    res.send("OK");
});

// ESP32 pergunta o estado do LED aqui
app.get('/api/comando_led', (req, res) => {
    res.json({ led: comando_led });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MATRIZ OPERACIONAL NA PORTA ${PORT}`);
});

// --- INTERFACE WEB ---
function getHtmlContent() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>ARES v5 - CLOUD</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <style>
        body { background-color: #050505; color: #00ffcc; font-family: 'Share Tech Mono', monospace; display: flex; flex-direction: column; align-items: center; padding: 20px; }
        .card { background: rgba(10, 10, 10, 0.8); padding: 20px; border: 1px solid #00ffcc; text-align: center; margin: 10px; min-width: 220px; box-shadow: 0 0 15px rgba(0,255,204,0.2); }
        .val { font-size: 2.8em; margin: 10px 0; color: #ff00ea; text-shadow: 2px 2px #000; }
        button { background: transparent; color: #ff00ea; border: 1px solid #ff00ea; padding: 12px 28px; cursor: pointer; margin: 10px; font-family: inherit; font-weight: bold; transition: 0.3s; }
        button:hover { background: #ff00ea; color: #000; box-shadow: 0 0 20px #ff00ea; }
        .ai-quote { color: #fce803; border-left: 4px solid #fce803; padding: 15px; background: rgba(252, 232, 3, 0.05); width: 85%; max-width: 800px; margin-top: 20px; min-height: 40px; }
        .chart-container { width: 90%; max-width: 800px; margin-top: 30px; background: rgba(0,0,0,0.5); padding: 15px; border: 1px solid #333; }
    </style></head>
    <body>
        <h1>[ ARES v5 // CLOUD MATRIZ ]</h1>
        <div style="display: flex; flex-wrap: wrap; justify-content: center;">
            <div class="card"><div>[ TEMP ]</div><div id="t" class="val">--.-°C</div></div>
            <div class="card"><div>[ UMID ]</div><div id="u" class="val" style="color: #00ffcc;">--%</div></div>
        </div>
        
        <div class="ai-quote" id="ai-text">> Link Neural em espera...</div>
        
        <div class="chart-container"><canvas id="grafico"></canvas></div>

        <div style="margin-top: 25px;">
            <button onclick="f('on')">ATIVAR LED</button>
            <button onclick="f('off')">DESATIVAR LED</button>
        </div>

    <script>
        let chart;
        function initChart() {
            const ctx = document.getElementById('grafico').getContext('2d');
            chart = new Chart(ctx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [
                        { label: 'Temperatura °C', borderColor: '#ff00ea', data: [], tension: 0.4, backgroundColor: 'rgba(255, 0, 234, 0.05)', fill: true },
                        { label: 'Umidade %', borderColor: '#00ffcc', data: [], tension: 0.4, backgroundColor: 'rgba(0, 255, 204, 0.05)', fill: true }
                    ] 
                },
                options: { 
                    responsive: true,
                    scales: { 
                        y: { grid: { color: '#222' }, ticks: { color: '#00ffcc' } },
                        x: { grid: { color: '#222' }, ticks: { color: '#00ffcc' } }
                    },
                    plugins: { legend: { labels: { color: '#fff', font: { family: 'Share Tech Mono' } } } },
                    animation: false
                }
            });
        }

        function update() {
            fetch('/api/data')
                .then(r => r.json())
                .then(d => {
                    if(d.error) return console.error(d.error);
                    document.getElementById('t').innerText = (d.temp || 0).toFixed(1) + '°C';
                    document.getElementById('u').innerText = (d.umid || 0).toFixed(0) + '%';
                    document.getElementById('ai-text').innerText = '> ' + (d.ia_msg || "Sincronizando...");

                    if(d.historico && d.historico.length > 0) {
                        chart.data.labels = d.historico.map(h => h.hora || '');
                        chart.data.datasets[0].data = d.historico.map(h => h.temperatura || 0);
                        chart.data.datasets[1].data = d.historico.map(h => h.umidade || 0);
                        chart.update();
                    }
                })
                .catch(e => console.error("Aguardando estabilização da rede..."));
        }

        function f(s) { 
            fetch('/api/led?state=' + s).then(() => console.log("Comando: " + s));
        }

        initChart();
        setInterval(update, 3000);
        update();
    </script></body></html>`;
}