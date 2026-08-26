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

module.exports = {
  apenasDigitos,
  validarCpf,
  validarCnpj,
  normalizarCpfCnpj,
  formatarCpfCnpj,
  normalizarTelefone,
};
