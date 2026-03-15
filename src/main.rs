use anyhow::Result;
use esp_idf_hal::prelude::*;
use esp_idf_hal::gpio::{PinDriver, Pull};
use esp_idf_hal::delay::Ets;
use esp_idf_hal::i2c::{I2cConfig, I2cDriver};
use esp_idf_svc::eventloop::EspSystemEventLoop;
use esp_idf_svc::nvs::{EspDefaultNvsPartition, EspNvs};
use esp_idf_svc::wifi::{AuthMethod, BlockingWifi, ClientConfiguration, Configuration, EspWifi, WifiDriver};
use esp_idf_svc::ipv4::{self, ClientSettings}; 
use esp_idf_svc::netif::{EspNetif, NetifConfiguration}; 
use esp_idf_svc::http::server::{Configuration as ServerConfig, EspHttpServer};
use esp_idf_svc::http::Method;
use esp_idf_svc::io::Write; 

use std::time::Duration;
use std::sync::{Arc, Mutex}; 

use dht_sensor::*;
use ssd1306::{prelude::*, I2CDisplayInterface, Ssd1306};
use embedded_graphics::{
    mono_font::{ascii::FONT_8X13, MonoTextStyleBuilder},
    pixelcolor::BinaryColor,
    prelude::*,
    text::{Baseline, Text},
};

// --- CONFIGURAÇÕES DE PRECISÃO ---
const CALIBRACAO_TEMP: f32 = -1.0; 
const TAMANHO_FILTRO: usize = 10;  

struct EstadoDoSistema {
    temperatura: f32,
    umidade: f32,
    led_ligado: bool,
    comando_led: Option<bool>,
    buffer_temp: Vec<f32>,
    buffer_umid: Vec<f32>,
}

impl Default for EstadoDoSistema {
    fn default() -> Self {
        Self {
            temperatura: 0.0,
            umidade: 0.0,
            led_ligado: false,
            comando_led: None,
            buffer_temp: Vec::with_capacity(TAMANHO_FILTRO),
            buffer_umid: Vec::with_capacity(TAMANHO_FILTRO),
        }
    }
}

fn conectar_wifi(
    modem: impl esp_idf_hal::peripheral::Peripheral<P = esp_idf_hal::modem::Modem> + 'static,
    sysloop: EspSystemEventLoop,
    nvs: EspDefaultNvsPartition,
) -> Result<BlockingWifi<EspWifi<'static>>> {
    
    let mut sta_config = NetifConfiguration::wifi_default_client();
    sta_config.ip_configuration = Some(ipv4::Configuration::Client(
        ipv4::ClientConfiguration::Fixed(ClientSettings {
            ip: ipv4::Ipv4Addr::new(192, 168, 18, 100),
            subnet: ipv4::Subnet {
                gateway: ipv4::Ipv4Addr::new(192, 168, 18, 1),
                mask: ipv4::Mask(24),
            },
            dns: Some(ipv4::Ipv4Addr::new(8, 8, 8, 8)),
            secondary_dns: Some(ipv4::Ipv4Addr::new(1, 1, 1, 1)),
        })
    ));

    let netif_sta = EspNetif::new_with_conf(&sta_config)?;
    let netif_ap = EspNetif::new_with_conf(&NetifConfiguration::wifi_default_router())?;
    let wifi_driver = WifiDriver::new(modem, sysloop.clone(), Some(nvs))?;
    let esp_wifi = EspWifi::wrap_all(wifi_driver, netif_sta, netif_ap)?;
    let mut wifi = BlockingWifi::wrap(esp_wifi, sysloop)?;

    let ssid = env!("WIFI_SSID");
    let psk = env!("WIFI_PSK");

    wifi.set_configuration(&Configuration::Client(ClientConfiguration {
        ssid: ssid.try_into().unwrap(),
        password: psk.try_into().unwrap(), 
        auth_method: AuthMethod::WPA2Personal,
        ..Default::default()
    }))?;

    wifi.start()?;
    wifi.connect()?;
    wifi.wait_netif_up()?; 
    Ok(wifi)
}

fn main() -> Result<()> {
    esp_idf_sys::link_patches();

    let peripherals = Peripherals::take().unwrap();
    let sysloop = EspSystemEventLoop::take()?;
    let nvs_default = EspDefaultNvsPartition::take()?;

    // AJUSTE 1: Removido 'mut' (Não necessário para leitura no NVS)
    let nvs = EspNvs::new(nvs_default.clone(), "ares_pref", true)?;
    let estado_inicial_led = nvs.get_u8("led_state")?.unwrap_or(0) != 0;

    let _wifi = conectar_wifi(peripherals.modem, sysloop, nvs_default.clone())?;

    let dados_compartilhados = Arc::new(Mutex::new(EstadoDoSistema {
        led_ligado: estado_inicial_led,
        ..Default::default()
    }));
    
    let api_dados = dados_compartilhados.clone();
    let api_led = dados_compartilhados.clone();
    let nvs_for_api = nvs_default.clone();

    let mut server = EspHttpServer::new(&ServerConfig::default())?;

    server.fn_handler("/", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let mut response = req.into_ok_response()?;
        response.write_all(get_html_content().as_bytes())?;
        Ok(())
    })?;

    server.fn_handler("/api/data", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let d = api_dados.lock().unwrap();
        let json = format!(r#"{{"temp":{:.2},"umid":{:.2},"led":{}}}"#, d.temperatura, d.umidade, d.led_ligado);
        let mut response = req.into_ok_response()?;
        response.write_all(json.as_bytes())?;
        Ok(())
    })?;

    server.fn_handler("/api/led", Method::Get, move |req| -> Result<(), anyhow::Error> {
        let mut d = api_led.lock().unwrap();
        let on = req.uri().contains("state=on");
        d.comando_led = Some(on);
        d.led_ligado = on;
        
        // AJUSTE 2: Removido 'mut' (O driver NVS gerencia a mutabilidade interna)
        if let Ok(nvs_storage) = EspNvs::new(nvs_for_api.clone(), "ares_pref", true) {
            let _ = nvs_storage.set_u8("led_state", if on { 1 } else { 0 });
        }
        
        let mut response = req.into_ok_response()?;
        response.write_all(b"OK")?;
        Ok(())
    })?;

    let mut pino_dht = PinDriver::input_output_od(peripherals.pins.gpio5)?;
    pino_dht.set_pull(Pull::Up)?; 
    let mut pino_led = PinDriver::output(peripherals.pins.gpio4)?;
    pino_led.set_level(estado_inicial_led.into())?; 
    
    let i2c_driver = I2cDriver::new(peripherals.i2c0, peripherals.pins.gpio1, peripherals.pins.gpio2, &I2cConfig::new().baudrate(400.kHz().into()))?;
    let mut display = Ssd1306::new(I2CDisplayInterface::new(i2c_driver), DisplaySize128x64, DisplayRotation::Rotate0).into_buffered_graphics_mode();
    display.init().unwrap();
    let estilo = MonoTextStyleBuilder::new().font(&FONT_8X13).text_color(BinaryColor::On).build();

    println!("ARES v4: Modo de Alta Precisão Ativo.");

    loop {
        for _ in 0..10 {
            let cmd = { let mut d = dados_compartilhados.lock().unwrap(); d.comando_led.take() };
            if let Some(c) = cmd { pino_led.set_level(c.into())?; }
            std::thread::sleep(Duration::from_millis(100));
        }

        if let Ok(l) = dht11::Reading::read(&mut Ets, &mut pino_dht) {
            let mut d = dados_compartilhados.lock().unwrap();
            let t_atual = (l.temperature as f32) + CALIBRACAO_TEMP;
            let u_atual = l.relative_humidity as f32;

            if d.buffer_temp.len() >= TAMANHO_FILTRO { d.buffer_temp.remove(0); }
            if d.buffer_umid.len() >= TAMANHO_FILTRO { d.buffer_umid.remove(0); }
            d.buffer_temp.push(t_atual);
            d.buffer_umid.push(u_atual);

            d.temperatura = d.buffer_temp.iter().sum::<f32>() / d.buffer_temp.len() as f32;
            d.umidade = d.buffer_umid.iter().sum::<f32>() / d.buffer_umid.len() as f32;
            
            display.clear_buffer();
            Text::with_baseline("ARES PRECISION", Point::new(0, 0), estilo, Baseline::Top).draw(&mut display).unwrap();
            Text::with_baseline(&format!("T:{:.2}C U:{:.1}%", d.temperatura, d.umidade), Point::new(0, 25), estilo, Baseline::Top).draw(&mut display).unwrap();
            Text::with_baseline(if d.led_ligado { "STATUS: ACTIVE" } else { "STATUS: IDLE" }, Point::new(0, 50), estilo, Baseline::Top).draw(&mut display).unwrap();
            display.flush().unwrap();
        }
    }
}

fn get_html_content() -> &'static str {
    r##"
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <title>ARES v4 - High Precision</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e14; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; width: 100%; max-width: 900px; }
        .card { background: #161b22; padding: 20px; border-radius: 12px; border: 1px solid #c0392b; text-align: center; }
        .value { font-size: 2.8rem; font-weight: bold; font-family: monospace; }
        .btn-group { margin-top: 30px; display: flex; gap: 20px; }
        .btn { padding: 15px 40px; border-radius: 8px; border: none; color: white; cursor: pointer; font-weight: bold; text-transform: uppercase; }
        .btn-on { background: #238636; } .btn-off { background: #da3633; }
    </style></head>
    <body>
        <h1 style="color:#c0392b">ARES COMMAND CENTER <small style="font-size:0.5em; color:gray">v4 Precision</small></h1>
        <div class="grid">
            <div class="card">
                <div>TEMPERATURE (SMOOTHED)</div>
                <div id="t" class="value" style="color:#f85149">--.--°C</div>
                <canvas id="ct" height="150"></canvas>
            </div>
            <div class="card">
                <div>HUMIDITY (SMOOTHED)</div>
                <div id="u" class="value" style="color:#58a6ff">--.--%</div>
                <canvas id="cu" height="150"></canvas>
            </div>
        </div>
        <div class="btn-group">
            <button onclick="f('on')" class="btn btn-on">Ignition</button>
            <button onclick="f('off')" class="btn btn-off">Shutdown</button>
        </div>
        <script>
            let cfg = (color) => ({
                type: 'line',
                data: { labels: Array(20).fill(''), datasets: [{ data: [], borderColor: color, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: color+'22' }] },
                options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#30363d' } } } }
            });
            let chartT = new Chart(document.getElementById('ct'), cfg('#f85149'));
            let chartU = new Chart(document.getElementById('cu'), cfg('#58a6ff'));
            function update() {
                fetch('/api/data').then(r => r.json()).then(d => {
                    document.getElementById('t').innerText = d.temp.toFixed(2) + '°C';
                    document.getElementById('u').innerText = d.umid.toFixed(2) + '%';
                    [chartT, chartU].forEach((c, i) => {
                        let val = i == 0 ? d.temp : d.umid;
                        c.data.datasets[0].data.push(val);
                        if(c.data.datasets[0].data.length > 20) c.data.datasets[0].data.shift();
                        c.update('none');
                    });
                });
            }
            function f(s) { fetch('/api/led?state=' + s).then(update); }
            setInterval(update, 2000); update();
        </script>
    </body></html>
    "##
}