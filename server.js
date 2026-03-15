const express = require('express');
const mysql = require('mysql2');

const app = express();
app.use(express.json()); 

// 1. Configura a conexão com o banco
const db = mysql.createConnection({
    host: 'localhost',      
    user: 'root',           
    password: 'Fobos@Deimos07', // <--- COLOQUE SUA SENHA AQUI
    database: 'ares_bd'
});

// 2. Tenta conectar
db.connect(err => {
    if (err) {
        console.error('[ERRO] Verifique se o MySQL está ligado e se a senha está correta:', err.message);
        return;
    }
    console.log('[SISTEMA] Conectado ao MySQL! Neural Link Ativo.');
});

// 3. Rota que recebe os dados do ESP32 (Rust)
app.post('/api/dados', (req, res) => {
    const { temperatura, umidade } = req.body;

    const sql = 'INSERT INTO leituras (temperatura, umidade) VALUES (?, ?)';
    db.query(sql, [temperatura, umidade], (err, result) => {
        if (err) {
            console.error('[ERRO] Falha ao salvar no banco:', err);
            return res.status(500).send('Erro no banco');
        }
        console.log(`[DADO RECEBIDO] Temp: ${temperatura}°C | Umid: ${umidade}% | ID: ${result.insertId}`);
        res.status(200).send('OK');
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('Servidor escutando na porta 3000...');
});