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

const groq = new Groq({ 
    apiKey: "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" 
});

// --- CONEXÃO COM O BANCO DE DADOS (AIVEN) ---
const uri_aiven = "mysql://avnadmin:AVNS_ve_Ovl6MuOzWmiWYOwb@mysql-15ef5ed3-thiagolsk8-8d2b.b.aivencloud.com:10432/defaultdb?ssl-mode=REQUIRED";

const db = mysql.createPool(uri_aiven); // Alterado para Pool para melhor estabilidade

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
    const sql = 'INSERT INTO leituras (temperatura, umidade) VALUES (?, ?)';
    
    db.query(sql, [temperatura, umidade], async (err) => {
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
            ultima_analise_ia = "Conexão Neural Instável.";
            res.status(200).send(ultima_analise_ia);
        }
    });
});

// Dashboard consome esses dados (JSON)
app.get('/api/data', (req, res) => {
    const sql = 'SELECT temperatura, umidade, DATE_FORMAT(data_hora, "%H:%i") as hora FROM leituras ORDER BY id DESC LIMIT 20';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({error: err});
        
        // Inverte para o gráfico ler da esquerda para a direita
        const historico = results.reverse();
        
        res.json({
            temp: results[results.length-1]?.temperatura || 0,
            umid: results[results.length-1]?.umidade || 0,
            ia_msg: ultima_analise_ia,
            led_state: comando_led,
            historico: historico
        });
    });
});

// Botão do site chama essa rota
app.get('/api/led', (req, res) => {
    comando_led = req.query.state === 'on';
    console.log(`💡 COMANDO LED -> ${comando_led ? 'ON' : 'OFF'}`);
    res.send("OK");
});

// ESP32 pergunta o estado do LED aqui (Polling)
app.get('/api/comando_led', (req, res) => {
    res.json({ led: comando_led });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MATRIZ OPERACIONAL NA PORTA ${PORT}`);
});

// --- INTERFACE WEB (REFORMULADA COM GRÁFICO) ---
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
                data: { labels: [], datasets: [{ label: 'Temperatura °C', borderColor: '#ff00ea', data: [], tension: 0.4, backgroundColor: 'rgba(255, 0, 234, 0.1)', fill: true }] },
                options: { 
                    responsive: true,
                    scales: { 
                        y: { grid: { color: '#222' }, ticks: { color: '#00ffcc' } },
                        x: { grid: { color: '#222' }, ticks: { color: '#00ffcc' } }
                    },
                    plugins: { legend: { labels: { color: '#00ffcc', font: { family: 'Share Tech Mono' } } } }
                }
            });
        }

        function update() {
            fetch('/api/data').then(r => r.json()).then(d => {
                document.getElementById('t').innerText = d.temp.toFixed(1) + '°C';
                document.getElementById('u').innerText = d.umid.toFixed(0) + '%';
                document.getElementById('ai-text').innerText = '> ' + d.ia_msg;

                // Atualizar Gráfico
                chart.data.labels = d.historico.map(h => h.hora);
                chart.data.datasets[0].data = d.historico.map(h => h.temp);
                chart.update('none'); // Update sem animação para não pesar
            }).catch(e => console.error("Erro na Matrix"));
        }

        function f(s) { 
            fetch('/api/led?state=' + s).then(() => {
                console.log("Comando enviado: " + s);
            });
        }

        initChart();
        setInterval(update, 3000);
        update();
    </script></body></html>`;
}
