/**
 * Validação e normalização de CPF, CNPJ e telefone.
 *
 * Existe porque cobrança fora do sistema (Asaas, banco, nota fiscal) recusa
 * documento inválido, e a recusa chega DEPOIS, no meio da emissão, com uma
 * mensagem do provedor que ninguém sabe interpretar. Validar na entrada é mais
 * barato que descobrir na hora de faturar.
 *
 * Conferir o dígito verificador, e não apenas o tamanho: "111.111.111-11" tem
 * onze dígitos e é inválido, e digitar um número errado é o erro mais comum de
 * quem preenche cadastro à mão.
 */

/** Só os dígitos. Aceita entrada com ponto, barra, traço ou espaço. */
function apenasDigitos(valor) {
  return String(valor ?? '').replace(/\D+/g, '');
}

/** Todos os dígitos iguais (111.111.111-11 e afins) nunca é documento válido. */
function todosIguais(digitos) {
  return /^(\d)\1+$/.test(digitos);
}

function digitoPorPesos(digitos, pesos) {
  const soma = pesos.reduce((total, peso, i) => total + Number(digitos[i]) * peso, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CPF: 11 dígitos e os dois verificadores conferem. */
function validarCpf(valor) {
  const d = apenasDigitos(valor);
  if (d.length !== 11 || todosIguais(d)) return false;

  const primeiro = digitoPorPesos(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (primeiro !== Number(d[9])) return false;

  const segundo = digitoPorPesos(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return segundo === Number(d[10]);
}

/** CNPJ: 14 dígitos e os dois verificadores conferem. */
function validarCnpj(valor) {
  const d = apenasDigitos(valor);
  if (d.length !== 14 || todosIguais(d)) return false;

  const primeiro = digitoPorPesos(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (primeiro !== Number(d[12])) return false;

  const segundo = digitoPorPesos(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return segundo === Number(d[13]);
}

/**
 * Normaliza o documento para gravação.
 *
 * Guarda SEM máscara: a comparação com o que já está no banco, e com o que o
 * provedor de cobrança devolve, não pode depender de quem digitou com ponto.
 * Formatar é problema da tela.
 *
 * @returns {{ ok: boolean, digitos?: string, tipo?: 'CPF'|'CNPJ', erro?: string }}
 */
function normalizarCpfCnpj(valor) {
  const d = apenasDigitos(valor);
  if (!d) return { ok: false, erro: 'Informe o CPF ou CNPJ.' };

  if (d.length === 11) {
    if (!validarCpf(d)) return { ok: false, erro: 'CPF inválido: confira os dígitos.' };
    return { ok: true, digitos: d, tipo: 'CPF' };
  }
  if (d.length === 14) {
    if (!validarCnpj(d)) return { ok: false, erro: 'CNPJ inválido: confira os dígitos.' };
    return { ok: true, digitos: d, tipo: 'CNPJ' };
  }
  return {
    ok: false,
    erro: `Documento deve ter 11 dígitos (CPF) ou 14 (CNPJ); recebi ${d.length}.`,
  };
}

/** Máscara para exibição. Documento fora do padrão volta como está. */
function formatarCpfCnpj(valor) {
  const d = apenasDigitos(valor);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/**
 * Normaliza telefone brasileiro para dígitos com DDD.
 *
 * Aceita 10 dígitos (fixo) e 11 (celular). Remove o 55 do início quando vem
 * junto, porque provedor de cobrança espera DDD + número, e "5511..." com 13
 * dígitos seria recusado como número inválido.
 *
 * Telefone é opcional: vazio devolve ok com null, para o campo poder ser
 * limpado sem virar erro de validação.
 */
function normalizarTelefone(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    return { ok: true, digitos: null };
  }

  let d = apenasDigitos(valor);
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);

  if (d.length !== 10 && d.length !== 11) {
    return { ok: false, erro: 'Telefone deve ter DDD + número (10 ou 11 dígitos).' };
  }
  // DDD brasileiro começa em 11.
  if (Number(d.slice(0, 2)) < 11) {
    return { ok: false, erro: 'DDD inválido.' };
  }
  return { ok: true, digitos: d };
}

/**
 * Normaliza CEP para oito dígitos.
 *
 * Existe pelo mesmo motivo do CPF/CNPJ: o provedor de cobrança exige CEP e
 * número do endereço para emitir BOLETO, e recusa com uma mensagem que fala em
 * "postalCode" — que não diz a ninguém qual campo da tela preencher.
 *
 * Opcional: vazio devolve ok com null, para o endereço poder ser limpado sem
 * virar erro. Quem exige o CEP é a emissão de boleto, não o cadastro.
 */
function normalizarCep(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    return { ok: true, digitos: null };
  }
  const d = apenasDigitos(valor);
  if (d.length !== 8) {
    return { ok: false, erro: `CEP deve ter 8 dígitos; recebi ${d.length}.` };
  }
  // 00000000 passa na contagem e não é endereço de ninguém.
  if (todosIguais(d)) return { ok: false, erro: 'CEP inválido.' };
  return { ok: true, digitos: d };
}

/** Máscara de CEP para exibição. Fora do padrão, volta como está. */
function formatarCep(valor) {
  const d = apenasDigitos(valor);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : d;
}

/** Sigla de estado. Opcional, mas quando vem tem que ser duas letras. */
function normalizarUf(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    return { ok: true, sigla: null };
  }
  const s = String(valor).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return { ok: false, erro: 'UF deve ter duas letras (ex.: SP).' };
  return { ok: true, sigla: s };
}

/**
 * Texto livre de endereço, limitado ao tamanho da coluna.
 *
 * Cortar aqui em vez de deixar o Postgres recusar com "value too long": o erro
 * do banco não diz qual campo estourou, e o endereço não é dado crítico o
 * suficiente para recusar o cadastro inteiro por causa de um complemento longo.
 */
function normalizarTexto(valor, limite) {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim().replace(/\s+/g, ' ');
  return t === '' ? null : t.slice(0, limite);
}

module.exports = {
  apenasDigitos,
  validarCpf,
  validarCnpj,
  normalizarCpfCnpj,
  formatarCpfCnpj,
  normalizarTelefone,
  normalizarCep,
  formatarCep,
  normalizarUf,
  normalizarTexto,
};
