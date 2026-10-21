const nutrientFields = [
  'energyKcal',
  'proteinG',
  'carbohydrateG',
  'fatG',
  'fiberG',
  'sodiumMg',
  'calciumMg',
] as const;

export function mountFoods(
  root: HTMLElement,
  messages: Record<string, string>,
  status: HTMLElement,
): void {
  const form = document.querySelector<HTMLFormElement>('#food-form')!;
  const list = document.querySelector<HTMLElement>('#food-list')!;
  const meals = document.querySelector<HTMLElement>('#meal-list')!;
  const search = document.querySelector<HTMLInputElement>('#food-search')!;
  const area = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
  const add = (parent: Node, child: Node) => parent.appendChild(child);
  let foods: any[] = [];
  let editing: any = null;
  let previewUrl = '';

  const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  const text = (id: string) => (field(id).value ?? '').trim();
  const showStatus = (message: string, alert = false) => {
    status.textContent = message;
    status.setAttribute('role', alert ? 'alert' : 'status');
  };
  const fail = (error: unknown) => {
    showStatus(error instanceof Error && error.message ? error.message : messages.failure!, true);
  };
  async function readJson(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error?.message ?? messages.failure);
    return result.data;
  }
  function optionalNutrient(raw: string): number | null {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(messages.invalidInput);
    return value;
  }
  function optionalPositive(raw: string): number | undefined {
    if (raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(messages.invalidInput);
    return value;
  }
  function contentType(file: File): string | null {
    if (file.type === 'image/jpg') return 'image/jpeg';
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return file.type;
    const name = file.name.toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    return null;
  }
  function setCoverPreview(src: string) {
    const img = document.querySelector<HTMLImageElement>('#food-cover-preview')!;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = src.startsWith('blob:') ? src : '';
    img.src = src;
    img.hidden = !src;
    const remove = document.querySelector<HTMLButtonElement>('#food-remove-cover')!;
    remove.hidden = !src && !text('food-cover-id');
  }
  function fillForm(entity: any | null) {
    editing = entity;
    const data = entity?.data ?? {};
    field('food-id').value = entity?.id ?? '';
    field('food-version').value = entity ? String(entity.version) : '';
    field('food-name').value = data.name ?? '';
    field('food-aliases').value = (data.aliases ?? []).join(', ');
    field('basis-quantity').value = data.basis?.quantity ?? '100';
    field('basis-unit').value = data.basis?.unit ?? 'g';
    field('serving-quantity').value = data.servingSize?.quantity ?? '';
    field('serving-unit').value = data.servingSize?.unit ?? 'g';
    field('density').value = data.densityGPerMl ?? '';
    field('food-preparation').value = data.preparation ?? 'as_sold';
    for (const key of nutrientFields) {
      const value = data.nutrients?.[key];
      field('nutrient-' + key).value = value == null ? '' : String(value);
    }
    field('food-source').value = data.source?.kind ?? 'user';
    area('food-basis').value = data.source?.basis ?? '';
    field('food-reference').value = data.source?.reference ?? '';
    area('food-notes').value = data.notes ?? '';
    field('food-cover-id').value = data.coverAssetId ?? '';
    field('food-thumb-id').value = data.coverThumbnailAssetId ?? '';
    (field('food-cover') as HTMLInputElement).value = '';
    setCoverPreview(
      data.coverAssetId ? `/api/v1/media/${encodeURIComponent(data.coverAssetId)}/content` : '',
    );
    document.querySelector<HTMLButtonElement>('#food-delete')!.hidden = !entity;
    document.querySelector<HTMLButtonElement>('#food-remove-cover')!.hidden = !data.coverAssetId;
  }
  function summary(food: any): string {
    const energy = food.nutrients?.energyKcal;
    const unit = food.basis.unit === 'serving' ? messages.unitServing : food.basis.unit;
    const value = energy == null ? messages.unknownEnergy : `${energy} kcal`;
    return `${value} / ${food.basis.quantity} ${unit}`;
  }
  function portionOf(food: any): { quantity: number; unit: string } {
    if (food.servingSize)
      return { quantity: food.servingSize.quantity, unit: food.servingSize.unit };
    return { quantity: food.basis.quantity, unit: food.basis.unit };
  }
  function renderFoods() {
    list.replaceChildren();
    if (!foods.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = messages.noFoods!;
      add(list, empty);
      return;
    }
    for (const entity of foods) {
      const food = entity.data;
      const card = document.createElement('article');
      card.className = 'food-card';
      if (food.coverAssetId) {
        const img = document.createElement('img');
        img.className = 'food-cover';
        img.alt = food.name;
        img.src = `/api/v1/media/${encodeURIComponent(food.coverAssetId)}/content`;
        add(card, img);
      } else {
        const blank = document.createElement('div');
        blank.className = 'food-cover';
        add(card, blank);
      }
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = food.name;
      const line = document.createElement('div');
      line.className = 'muted';
      line.textContent = summary(food);
      add(body, title);
      add(body, line);
      if (food.aliases?.length) {
        const aliases = document.createElement('div');
        aliases.className = 'muted';
        aliases.textContent = food.aliases.join(', ');
        add(body, aliases);
      }
      const log = document.createElement('form');
      log.className = 'food-log';
      log.dataset.id = entity.id;
      const portion = portionOf(food);
      const amount = document.createElement('input');
      amount.className = 'portion';
      amount.type = 'number';
      amount.min = '0';
      amount.step = 'any';
      amount.required = true;
      amount.value = String(portion.quantity);
      amount.setAttribute('aria-label', messages.basisQuantity!);
      const unit = document.createElement('select');
      unit.className = 'portion-unit';
      unit.setAttribute('aria-label', messages.basisUnit!);
      for (const value of ['g', 'ml', 'serving']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'serving' ? messages.unitServing! : value;
        option.selected = value === portion.unit;
        add(unit, option);
      }
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = messages.logPortion!;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary edit';
      edit.textContent = messages.editFood!;
      edit.addEventListener('click', () => {
        fillForm(entity);
        form.scrollIntoView({ block: 'start' });
      });
      add(log, amount);
      add(log, unit);
      add(log, submit);
      add(log, edit);
      add(body, log);
      add(card, body);
      add(list, card);
    }
  }
  function renderMeals(items: any[]) {
    meals.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = messages.noMeals!;
      add(meals, empty);
      return;
    }
    const timeZone = root.dataset.timeZone || 'UTC';
    const format = new Intl.DateTimeFormat(document.documentElement.lang || 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
    for (const meal of items) {
      const row = document.createElement('p');
      const names = (meal.data.ingredients ?? [])
        .map((item: any) => {
          const unit = item.unit === 'serving' ? messages.unitServing : item.unit;
          return `${item.label} ${item.quantity} ${unit}`;
        })
        .join(', ');
      const kcal = meal.data.nutrients?.energyKcal;
      const energy = kcal == null ? messages.unknownEnergy : `${kcal} kcal`;
      row.textContent = `${format.format(new Date(meal.data.occurredAt))} — ${names} — ${energy}`;
      add(meals, row);
    }
  }
  let foodLoad = 0;
  async function loadFoods() {
    const token = ++foodLoad;
    const query = search.value.trim();
    const params = new URLSearchParams({ limit: '50' });
    if (query) params.set('query', query);
    const page = await api('GET', '/api/v1/foods?' + params.toString());
    if (token !== foodLoad) return;
    foods = page.items ?? [];
    renderFoods();
  }
  async function loadMeals() {
    const page = await api('GET', '/api/v1/meals?limit=8');
    renderMeals(page.items ?? []);
  }
  async function uploadCover(file: File): Promise<string> {
    const type = contentType(file);
    if (!type) throw new Error(messages.invalidImage);
    const ticket = await api('POST', '/api/v1/media/uploads', {
      operationId: crypto.randomUUID(),
      contentType: type,
      role: 'food_cover',
      processing: 'Owner-provided product photo',
    });
    const uploaded = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': type },
      body: file,
    });
    const result = await readJson(uploaded);
    if (!uploaded.ok) throw new Error(result.error?.message ?? messages.failure);
    return ticket.asset.id as string;
  }
  function buildData(base: any): any {
    const note = area('food-basis').value.trim();
    const reference = text('food-reference');
    const coverId = text('food-cover-id');
    const data: any = {
      ...base,
      name: text('food-name'),
      aliases: text('food-aliases')
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
      nutrients: { ...(base.nutrients ?? {}) },
      basis: {
        quantity: optionalPositive(text('basis-quantity')),
        unit: field('basis-unit').value,
      },
      preparation: field('food-preparation').value,
      source: {
        kind: field('food-source').value,
        ...(note ? { basis: note } : {}),
        ...(reference ? { reference } : {}),
      },
      notes: area('food-notes').value,
      coverAssetId: coverId || null,
      coverThumbnailAssetId: coverId ? text('food-thumb-id') || null : null,
    };
    for (const key of nutrientFields)
      data.nutrients[key] = optionalNutrient(text('nutrient-' + key));
    if (!data.basis.quantity) throw new Error(messages.invalidInput);
    const serving = optionalPositive(text('serving-quantity'));
    if (serving) data.servingSize = { quantity: serving, unit: field('serving-unit').value };
    else delete data.servingSize;
    const density = optionalPositive(text('density'));
    if (density) data.densityGPerMl = density;
    else delete data.densityGPerMl;
    return data;
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#food-save');
    void (async () => {
      if (button) button.disabled = true;
      try {
        const file = (field('food-cover') as HTMLInputElement).files?.[0];
        if (file) field('food-cover-id').value = await uploadCover(file);
        const id = text('food-id');
        const version = text('food-version');
        const saved = await api('POST', '/api/v1/foods', {
          operationId: crypto.randomUUID(),
          ...(id ? { id, expectedVersion: Number(version) } : {}),
          data: buildData(editing?.data ?? {}),
        });
        fillForm(saved);
        showStatus(messages.foodSaved!);
        await loadFoods();
      } catch (error) {
        fail(error);
      } finally {
        if (button) button.disabled = false;
      }
    })();
  });
  document.querySelector('#food-reset')?.addEventListener('click', () => {
    fillForm(null);
    showStatus('');
  });
  document.querySelector('#food-remove-cover')?.addEventListener('click', () => {
    field('food-cover-id').value = '';
    field('food-thumb-id').value = '';
    (field('food-cover') as HTMLInputElement).value = '';
    setCoverPreview('');
  });
  document.querySelector('#food-delete')?.addEventListener('click', () => {
    const id = text('food-id');
    const version = text('food-version');
    if (!id || !confirm(messages.confirmDeleteFood)) return;
    void (async () => {
      try {
        await api('DELETE', '/api/v1/foods/' + encodeURIComponent(id), {
          operationId: crypto.randomUUID(),
          expectedVersion: Number(version),
        });
        fillForm(null);
        showStatus(messages.success!);
        await loadFoods();
      } catch (error) {
        fail(error);
      }
    })();
  });
  list.addEventListener('submit', (event) => {
    const log = event.target as HTMLFormElement;
    if (!log.classList.contains('food-log')) return;
    event.preventDefault();
    const button = log.querySelector<HTMLButtonElement>('button[type="submit"]');
    void (async () => {
      if (button) button.disabled = true;
      try {
        const quantity = Number(
          (log.querySelector('.portion') as unknown as HTMLInputElement).value,
        );
        const unit = (log.querySelector('.portion-unit') as unknown as HTMLSelectElement).value;
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(messages.invalidInput);
        const meal = await api('POST', '/api/v1/meals', {
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          ingredients: [{ foodId: log.dataset.id, quantity, unit }],
        });
        const kcal = meal.data?.nutrients?.energyKcal;
        showStatus(
          `${messages.mealLogged} ${kcal == null ? messages.unknownEnergy : kcal + ' kcal'}`,
        );
        await loadMeals();
      } catch (error) {
        fail(error);
      } finally {
        if (button) button.disabled = false;
      }
    })();
  });
  let searchTimer = 0;
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void loadFoods().catch(fail);
    }, 250);
  });
  field('food-cover').addEventListener('change', () => {
    const file = (field('food-cover') as HTMLInputElement).files?.[0];
    if (!file) return;
    setCoverPreview(URL.createObjectURL(file));
    document.querySelector<HTMLButtonElement>('#food-remove-cover')!.hidden = false;
  });
  void loadFoods().catch(fail);
  void loadMeals().catch(fail);
}
