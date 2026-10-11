const $ = (id) => document.getElementById(id);
let view = null;

async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ---------- keys ----------

function renderKeys() {
    const box = $('keys');
    box.replaceChildren();
    for (const [id, p] of Object.entries(view.providers)) {
        const row = document.createElement('div');
        row.className = 'row key-row';
        const label = document.createElement('label');
        label.htmlFor = `key-${id}`;
        label.textContent = p.name;
        const controls = document.createElement('div');
        controls.className = 'controls';
        const input = document.createElement('input');
        input.type = 'password'; input.id = `key-${id}`; input.autocomplete = 'off'; input.spellcheck = false;
        input.placeholder = p.hasKey ? 'Paste a new key to replace it' : 'Paste API key';
        const save = document.createElement('button');
        save.textContent = 'Save key';
        const remove = document.createElement('button');
        remove.textContent = 'Remove';
        remove.hidden = !p.hasKey;
        controls.append(input, save, remove);
        const spacer = document.createElement('span');
        const status = document.createElement('span');
        status.className = `status ${p.hasKey ? 'ok' : ''}`;
        status.textContent = `Key ${p.key}. `;
        const link = document.createElement('a');
        link.href = p.keyUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `Get an API key from ${p.name}`;
        status.append(link);

        const submit = async (key) => {
            save.disabled = remove.disabled = true;
            try {
                view = await api('/api/settings/key', { provider: id, key });
                renderKeys(); renderModels();
            } catch (e) {
                status.className = 'status bad'; status.textContent = e.message;
                save.disabled = remove.disabled = false;
            }
        };
        save.onclick = () => input.value.trim() && submit(input.value);
        input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) submit(input.value); };
        remove.onclick = () => submit('');
        row.append(label, controls, spacer, status);
        box.append(row);
    }
}

// ---------- models ----------

function fillProviders(sel, allowNone) {
    sel.replaceChildren();
    if (allowNone) sel.append(new Option('None', ''));
    for (const [id, p] of Object.entries(view.providers)) sel.append(new Option(p.hasKey ? p.name : `${p.name} (no key)`, id));
}

function fillModels(sel, providerId) {
    sel.replaceChildren();
    sel.disabled = !providerId;
    if (!providerId) return;
    for (const m of view.providers[providerId].models) sel.append(new Option(`${m.label} — ${m.note}`, m.id));
}

function bind(prefix, choice, allowNone) {
    const pSel = $(`${prefix}-provider`), mSel = $(`${prefix}-model`);
    fillProviders(pSel, allowNone);
    pSel.value = choice ? choice.provider : '';
    fillModels(mSel, pSel.value);
    if (choice) mSel.value = choice.model;
    pSel.onchange = () => { fillModels(mSel, pSel.value); $('save-status').textContent = 'Unsaved changes'; $('save-status').className = 'status'; };
    mSel.onchange = () => { $('save-status').textContent = 'Unsaved changes'; $('save-status').className = 'status'; };
    $(`${prefix}-test`).disabled = !choice && !pSel.value;
    pSel.addEventListener('change', () => { $(`${prefix}-test`).disabled = !pSel.value; });
}

function current(prefix) {
    const provider = $(`${prefix}-provider`).value;
    return provider ? { provider, model: $(`${prefix}-model`).value } : null;
}

function renderModels() {
    bind('p', view.primary, false);
    bind('f', view.fallback, true);
}

async function test(prefix) {
    const out = $(`${prefix}-result`), btn = $(`${prefix}-test`);
    const choice = current(prefix);
    if (!choice) return;
    btn.disabled = true;
    out.className = 'result';
    out.textContent = 'Testing…';
    try {
        const r = await api('/api/settings/test', choice);
        const lang = r.language ? `${r.language}: ` : '';
        out.textContent = `OK in ${(r.ms / 1000).toFixed(1)} s. ${lang}${r.text ? `"${r.text.slice(0, 160)}${r.text.length > 160 ? '…' : ''}"` : '(no speech in that clip)'}`;
    } catch (e) {
        out.className = 'result bad';
        out.textContent = e.message;
    } finally {
        btn.disabled = false;
    }
}

$('p-test').onclick = () => test('p');
$('f-test').onclick = () => test('f');

$('save').onclick = async () => {
    const status = $('save-status');
    try {
        view = await api('/api/settings', { primary: current('p'), fallback: current('f') });
        status.className = 'status ok';
        status.textContent = 'Saved';
    } catch (e) {
        status.className = 'status bad';
        status.textContent = e.message;
    }
};

view = await api('/api/settings');
renderKeys();
renderModels();
