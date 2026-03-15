use esp_idf_hal::io::Write;
use anyhow::Result;
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex}; 
use std::thread;
use std::net::Ipv4Addr; 


// HAL e Unidades
use esp_idf_hal::gpio::{PinDriver, Pull};
use esp_idf_hal::delay::Ets;
use esp_idf_hal::i2c::{I2cConfig, I2cDriver};
use esp_idf_hal::units::*; 
use esp_idf_hal::peripherals::Peripherals;

// Serviços ESP-IDF
use esp_idf_svc::eventloop::EspSystemEventLoop;
use esp_idf_svc::nvs::{EspDefaultNvsPartition, EspNvs};
use esp_idf_svc::wifi::{AuthMethod, BlockingWifi, ClientConfiguration, Configuration as WifiConf, EspWifi, WifiDriver};
use esp_idf_svc::netif::{EspNetif, NetifConfiguration};
use esp_idf_svc::ipv4::{Configuration as Ipv4Conf, ClientConfiguration as Ipv4ClientConf, ClientSettings, Subnet, Mask}; 

// HTTP Server e Client
use esp_idf_svc::http::server::{Configuration as ServerConfig, EspHttpServer};
use esp_idf_svc::http::client::{Configuration as HttpClientConfig, EspHttpConnection};
use esp_idf_svc::http::Method;
use embedded_svc::http::client::Client;

// Sensores e Display
use dht_sensor::*;
use ssd1306::{prelude::*, I2CDisplayInterface, Ssd1306};
use embedded_graphics::{
    mono_font::{ascii::FONT_8X13, MonoTextStyleBuilder},
    pixelcolor::BinaryColor,
    prelude::*,
    text::{Baseline, Text},
};

// --- CONFIGURAÇÕES ---
const CALIBRACAO_TEMP: f32 = -1.0; 
const TAMANHO_FILTRO: usize = 10;
const LIMITE_TEMP_ALERTA: f32 = 30.0;

struct EstadoDoSistema {
    temperatura: f32,
    umidade: f32,
    led_ligado: bool,
    comando_led: Option<bool>,
    buffer_temp: Vec<f32>,
    inicio_sistema: Instant,
}

impl Default for EstadoDoSistema {
    fn default() -> Self {
        Self {
            temperatura: 0.0,
            umidade: 0.0,
            led_ligado: false,
            comando_led: None,
            buffer_temp: Vec::with_capacity(TAMANHO_FILTRO),
            inicio_sistema: Instant::now(),
        }
    }
}

fn main() -> Result<()> {
    esp_idf_sys::link_patches();
    let peripherals = Peripherals::take().unwrap();
    let sysloop = EspSystemEventLoop::take()?;
    let nvs_default = EspDefaultNvsPartition::take()?;

    let nvs = EspNvs::new(nvs_default.clone(), "ares_pref", true)?;
    let estado_inicial_led = nvs.get_u8("led_state")?.unwrap_or(0) != 0;

    // --- INÍCIO DO WI-FI ---
    let mut sta_config = NetifConfiguration::wifi_default_client();
    sta_config.ip_configuration = Some(Ipv4Conf::Client(
        Ipv4ClientConf::Fixed(ClientSettings {
            ip: Ipv4Addr::new(192, 168, 18, 100),
            subnet: Subnet {
                gateway: Ipv4Addr::new(192, 168, 18, 1),
                mask: Mask(24),
            },
            dns: Some(Ipv4Addr::new(8, 8, 8, 8)),
            secondary_dns: Some(Ipv4Addr::new(1, 1, 1, 1)),
        })
    ));

    let netif_sta = EspNetif::new_with_conf(&sta_config)?;
    let netif_ap = EspNetif::new_with_conf(&NetifConfiguration::wifi_default_router())?;
    
    let wifi_driver = WifiDriver::new(peripherals.modem, sysloop.clone(), Some(nvs_default.clone()))?;
    let esp_wifi = EspWifi::wrap_all(wifi_driver, netif_sta, netif_ap)?;
    let mut wifi = BlockingWifi::wrap(esp_wifi, sysloop.clone())?;

    wifi.set_configuration(&WifiConf::Client(ClientConfiguration {
        ssid: "3M_2Ghz".try_into().unwrap(),
        password: "20191425".try_into().unwrap(), 
        auth_method: AuthMethod::WPA2Personal,
        ..Default::default()
    }))?;

    wifi.start()?;
    wifi.connect()?;
    wifi.wait_netif_up()?; 
    
    let _wifi = wifi; 
    // --- FIM DO WI-FI ---

    let estado = Arc::new(Mutex::new(EstadoDoSistema {
        led_ligado: estado_inicial_led,
        ..Default::default()
    }));
    
    // --- SERVER (CORE 0) ---
    let estado_data = estado.clone();
    let estado_led = estado.clone();
    let nvs_api = nvs_default.clone();
    
    let mut server = EspHttpServer::new(&ServerConfig::default())?;

    server.fn_handler("/", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let mut response = req.into_ok_response()?;
        response.write_all(get_html_content().as_bytes())?;
        Ok(())
    })?;

    server.fn_handler("/api/data", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let e = estado_data.lock().unwrap();
        let json = format!(
            r#"{{"temp":{:.2},"umid":{:.2},"led":{},"uptime":{},"ia_msg":"[SISTEMA]: Aguardando conexão Neural com a Matriz..."}}"#, 
            e.temperatura, e.umidade, e.led_ligado, e.inicio_sistema.elapsed().as_secs()
        );
        let mut response = req.into_ok_response()?;
        response.write_all(json.as_bytes())?;
        Ok(())
    })?;

    server.fn_handler("/api/led", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let mut e = estado_led.lock().unwrap();
        let on = req.uri().contains("state=on");
        e.comando_led = Some(on);
        e.led_ligado = on;
        if let Ok(nvs_s) = EspNvs::new(nvs_api.clone(), "ares_pref", true) {
            let _ = nvs_s.set_u8("led_state", if on { 1 } else { 0 });
        }
        let mut response = req.into_ok_response()?;
        response.write_all(b"OK")?;
        Ok(())
    })?;

    // --- SENSORES E DISPLAY (CORE 1) ---
    let sensor_estado = estado.clone();
    
    let mut pino_dht = PinDriver::input_output_od(peripherals.pins.gpio5)?;
    pino_dht.set_pull(Pull::Up)?;
    let mut pino_led = PinDriver::output(peripherals.pins.gpio4)?;
    pino_led.set_level(estado_inicial_led.into())?; 
    
    let i2c = I2cDriver::new(peripherals.i2c0, peripherals.pins.gpio1, peripherals.pins.gpio2, &I2cConfig::new().baudrate(400.kHz().into()))?;
    let interface = I2CDisplayInterface::new(i2c);
    let mut display = Ssd1306::new(interface, DisplaySize128x64, DisplayRotation::Rotate0).into_buffered_graphics_mode();
    display.init().unwrap();

    thread::Builder::new()
        .stack_size(10240)
        .name("sensor_task".to_string())
        .spawn(move || {
            let estilo = MonoTextStyleBuilder::new().font(&FONT_8X13).text_color(BinaryColor::On).build();
            loop {
                for _ in 0..10 {
                    let cmd = { sensor_estado.lock().unwrap().comando_led.take() };
                    if let Some(c) = cmd { let _ = pino_led.set_level(c.into()); }
                    thread::sleep(Duration::from_millis(100));
                }

                if let Ok(l) = dht11::Reading::read(&mut Ets, &mut pino_dht) {
                    let t_lida = (l.temperature as f32) + CALIBRACAO_TEMP;
                    let u_lida = l.relative_humidity as f32;

                    {
                        let mut e = sensor_estado.lock().unwrap();
                        if e.buffer_temp.len() >= TAMANHO_FILTRO { e.buffer_temp.remove(0); }
                        e.buffer_temp.push(t_lida);
                        e.temperatura = e.buffer_temp.iter().sum::<f32>() / e.buffer_temp.len() as f32;
                        e.umidade = u_lida;
                    }

                    display.clear_buffer();
                    let _ = Text::with_baseline("ARES v5 PRO", Point::new(0, 0), estilo, Baseline::Top).draw(&mut display);
                    let _ = Text::with_baseline(&format!("T:{:.1}C U:{:.0}%", t_lida, u_lida), Point::new(0, 25), estilo, Baseline::Top).draw(&mut display);
                    let msg = if t_lida > LIMITE_TEMP_ALERTA { "ALERTA: QUENTE" } else { "SISTEMA NORMAL" };
                    let _ = Text::with_baseline(msg, Point::new(0, 50), estilo, Baseline::Top).draw(&mut display);
                    let _ = display.flush();
                }
            }
        })?;

    // --- UPLINK PARA O BANCO DE DADOS (NOVA THREAD) ---
    let db_estado = estado.clone();
    
    thread::Builder::new()
        .stack_size(8192)
        .name("db_task".to_string())
        .spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(30)); 

                let (t, u) = {
                    let e = db_estado.lock().unwrap();
                    (e.temperatura, e.umidade)
                };
                
                if t != 0.0 && u != 0.0 { 
                    println!("[UPLINK] Tentando enviar Temp: {:.1} / Umid: {:.0}%...", t, u);
                    if let Err(err) = enviar_dados_para_banco(t, u) {
                        println!("[ERRO UPLINK] Falha ao contatar o servidor: {}", err);
                    }
                }
            }
        })?;

    loop { thread::sleep(Duration::from_secs(60)); }
}

fn enviar_dados_para_banco(temperatura: f32, umidade: f32) -> Result<()> {
    let url = "http://192.168.18.44:3000/api/dados"; 
    let payload = format!(r#"{{"temperatura": {:.2}, "umidade": {:.2}}}"#, temperatura, umidade);

    let connection = EspHttpConnection::new(&HttpClientConfig {
        use_global_ca_store: false, 
        crt_bundle_attach: None,
        ..Default::default()
    })?;
    let mut client = Client::wrap(connection);

    let headers = [
        ("content-type", "application/json"),
        ("content-length", &payload.len().to_string()),
    ];

    let mut request = client.post(url, &headers)?;
    // Graças ao std::io::Write, isso vai compilar lindamente:
    request.write_all(payload.as_bytes())?; 
    
    let response = request.submit()?;
    println!("[UPLINK] Dados enviados! Status: {}", response.status());

    Ok(())
}

fn get_html_content() -> &'static str {
    r##"
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>ARES v5 - NEURAL LINK</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <style>
        body { background-color: #050505; color: #00ffcc; font-family: 'Share Tech Mono', monospace; display: flex; flex-direction: column; align-items: center; padding: 20px; margin: 0; background-image: linear-gradient(rgba(0, 255, 204, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 204, 0.05) 1px, transparent 1px); background-size: 20px 20px; }
        h1 { color: #ff00ea; text-shadow: 0 0 10px #ff00ea; letter-spacing: 3px; font-weight: normal; }
        .container { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; max-width: 900px; width: 100%; margin-top: 20px; }
        .card { background: rgba(10, 10, 10, 0.8); padding: 20px; border-radius: 5px; border: 1px solid #00ffcc; text-align: center; flex: 1; min-width: 200px; box-shadow: 0 0 10px rgba(0, 255, 204, 0.2); }
        .val { font-size: 2.8em; margin: 10px 0; text-shadow: 0 0 5px currentColor; }
        .temp-text { color: #ff00ea; }
        .umid-text { color: #00ffcc; }
        .chart-container { width: 100%; max-width: 850px; background: rgba(10, 10, 10, 0.8); padding: 20px; border-radius: 5px; border: 1px solid #30363d; margin-top: 20px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); }
        .ai-quote { margin-top: 20px; max-width: 850px; width: 100%; font-style: italic; color: #fce803; text-shadow: 0 0 5px #fce803; border-left: 4px solid #fce803; padding: 15px; background: rgba(252, 232, 3, 0.05); font-size: 1.2em; min-height: 50px; display: flex; align-items: center; }
        .btn-group { margin-top: 25px; }
        button { background: transparent; color: #ff00ea; border: 1px solid #ff00ea; padding: 12px 28px; font-family: 'Share Tech Mono', monospace; font-size: 1em; cursor: pointer; transition: 0.3s; margin: 0 10px; text-transform: uppercase; }
        button:hover { background: #ff00ea; color: #000; box-shadow: 0 0 15px #ff00ea; }
        .footer { margin-top: 30px; font-family: monospace; color: #555; font-size: 0.8em; }
    </style></head><body>

    <h1>[ ARES v5 // UPLINK ]</h1>

    <div class="container">
        <div class="card">
            <div style="color: #666; font-size: 0.9em;">[ SENSOR_TEMP ]</div>
            <div id="t" class="val temp-text">--.-°C</div>
        </div>
        <div class="card">
            <div style="color: #666; font-size: 0.9em;">[ SENSOR_UMID ]</div>
            <div id="u" class="val umid-text">--%</div>
        </div>
    </div>

    <div class="ai-quote" id="ai-text">> Aguardando sincronização...</div>

    <div class="chart-container">
        <canvas id="mainChart" height="120"></canvas>
    </div>

    <div class="btn-group">
        <button onclick="f('on')">OVERRIDE: LED ON</button>
        <button onclick="f('off')">OVERRIDE: LED OFF</button>
    </div>

    <div id="up" class="footer">SYS_UPTIME: 0s | STATUS: INICIALIZANDO</div>

    <script>
        Chart.defaults.color = '#00ffcc';
        Chart.defaults.font.family = "'Share Tech Mono', monospace";
        
        const ctx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'TEMP_CORE (°C)', data: [], borderColor: '#ff00ea', backgroundColor: 'rgba(255, 0, 234, 0.1)', borderWidth: 2, tension: 0.1, fill: true, yAxisID: 'y', pointRadius: 0 },
                    { label: 'UMID_ATM (%)', data: [], borderColor: '#00ffcc', backgroundColor: 'rgba(0, 255, 204, 0.1)', borderWidth: 2, tension: 0.1, fill: true, yAxisID: 'y1', pointRadius: 0 }
                ]
            },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { labels: { color: '#00ffcc' } } },
                scales: {
                    y: { type: 'linear', display: true, position: 'left', grid: { color: '#1a1a1a' }, ticks: { color: '#ff00ea' } },
                    y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#00ffcc' } },
                    x: { grid: { color: '#1a1a1a' }, ticks: { color: '#555' } }
                }
            }
        });

        function update() {
            fetch('/api/data').then(r => r.json()).then(d => {
                document.getElementById('t').innerText = d.temp.toFixed(1) + '°C';
                document.getElementById('u').innerText = d.umid.toFixed(0) + '%';
                document.getElementById('up').innerText = 'SYS_UPTIME: ' + d.uptime + 's | STATUS: ONLINE';
                document.getElementById('ai-text').innerText = '> ' + d.ia_msg;

                const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                
                if(chart.data.labels.length > 20) {
                    chart.data.labels.shift();
                    chart.data.datasets[0].data.shift();
                    chart.data.datasets[1].data.shift();
                }

                chart.data.labels.push(now);
                chart.data.datasets[0].data.push(d.temp);
                chart.data.datasets[1].data.push(d.umid);
                chart.update('none'); 
            }).catch(err => {
                document.getElementById('up').innerText = 'CRITICAL ERROR: CONNECTION LOST';
                document.getElementById('ai-text').innerText = '> ERRO DE TRANSMISSÃO NEURAL.';
            });
        }

        function f(s) { fetch('/api/led?state=' + s); }
        setInterval(update, 2000); 
        update();
    </script></body></html>"##
}