/** Parse [provider/]model[:effort] without imposing a provider registry. */
export function parseModelSpec(value) {
  if (!value?.trim()) return {};
  let model = value.trim();
  const fields = {};
  const slash = model.indexOf('/');
  if (slash !== -1) {
    const provider = model.slice(0, slash);
    if (provider) fields.provider = provider;
    model = model.slice(slash + 1);
  }
  const colon = model.lastIndexOf(':');
  if (colon !== -1 && /^(low|medium|high|max|minimal|xhigh)$/i.test(model.slice(colon + 1))) {
    fields.effort = model.slice(colon + 1);
    model = model.slice(0, colon);
  }
  if (model) fields.model = model;
  return fields;
}
