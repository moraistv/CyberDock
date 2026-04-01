/**
 * Exemplo de uso da BillingPeriodCalculator
 * 
 * Este arquivo demonstra como usar a calculadora de período
 * para resolver o problema de itens aparecendo na cobrança
 * do mês errado.
 */

import { billingPeriodCalculator } from './BillingPeriodCalculator.js';

// Exemplo 1: Calculando período de setembro de 2024
console.log('=== EXEMPLO 1: Período de Setembro 2024 ===');
const setembroPeriod = billingPeriodCalculator.calculatePeriod(2024, 9);
console.log('Período:', billingPeriodCalculator.formatPeriod(setembroPeriod));
console.log('Detalhado:', billingPeriodCalculator.formatPeriodDetailed(setembroPeriod));
console.log('Início:', setembroPeriod.startDate.toISOString());
console.log('Fim:', setembroPeriod.endDate.toISOString());
console.log('Dias no mês:', setembroPeriod.daysInMonth);

// Exemplo 2: Testando o problema reportado
console.log('\n=== EXEMPLO 2: Testando o Bug Reportado ===');

// Simulando itens com diferentes datas
const itens = [
    { id: 1, descricao: 'Venda expedida em agosto', data: new Date(2024, 7, 31, 23, 59, 59) },
    { id: 2, descricao: 'Venda expedida em setembro - início', data: new Date(2024, 8, 1, 0, 0, 0) },
    { id: 3, descricao: 'Armazenamento setembro - meio', data: new Date(2024, 8, 15, 12, 30, 0) },
    { id: 4, descricao: 'Serviço setembro - fim', data: new Date(2024, 8, 30, 23, 59, 59) },
    { id: 5, descricao: 'Venda expedida em outubro', data: new Date(2024, 9, 1, 0, 0, 0) }
];

// Filtrando itens que devem aparecer na cobrança de setembro
const itensSetembro = itens.filter(item => 
    billingPeriodCalculator.isDateInPeriod(item.data, setembroPeriod.startDate, setembroPeriod.endDate)
);

console.log('Itens que DEVEM aparecer na cobrança de setembro:');
itensSetembro.forEach(item => {
    console.log(`- ${item.descricao} (${item.data.toLocaleString('pt-BR')})`);
});

console.log('\nItens que NÃO devem aparecer na cobrança de setembro:');
const itensForaPeriodo = itens.filter(item => 
    !billingPeriodCalculator.isDateInPeriod(item.data, setembroPeriod.startDate, setembroPeriod.endDate)
);
itensForaPeriodo.forEach(item => {
    console.log(`- ${item.descricao} (${item.data.toLocaleString('pt-BR')})`);
});

// Exemplo 3: Comparando períodos
console.log('\n=== EXEMPLO 3: Comparando Períodos ===');
const agostoPeriod = billingPeriodCalculator.calculatePeriod(2024, 8);
const outubroPeriod = billingPeriodCalculator.calculatePeriod(2024, 10);

console.log('Agosto:', billingPeriodCalculator.formatPeriodDetailed(agostoPeriod));
console.log('Setembro:', billingPeriodCalculator.formatPeriodDetailed(setembroPeriod));
console.log('Outubro:', billingPeriodCalculator.formatPeriodDetailed(outubroPeriod));

// Exemplo 4: Navegação entre períodos
console.log('\n=== EXEMPLO 4: Navegação entre Períodos ===');
const periodoAnterior = billingPeriodCalculator.getPreviousPeriod(2024, 9);
const proximoPeriodo = billingPeriodCalculator.getNextPeriod(2024, 9);

console.log('Período anterior a setembro:', billingPeriodCalculator.formatPeriod(periodoAnterior));
console.log('Período atual:', billingPeriodCalculator.formatPeriod(setembroPeriod));
console.log('Próximo período:', billingPeriodCalculator.formatPeriod(proximoPeriodo));

// Exemplo 5: Formato para queries SQL
console.log('\n=== EXEMPLO 5: Formato para SQL ===');
const sqlFormat = billingPeriodCalculator.toSQLFormat(setembroPeriod);
console.log('Para usar em queries SQL:');
console.log('START_DATE:', sqlFormat.startDate);
console.log('END_DATE:', sqlFormat.endDate);

// Exemplo de query SQL que seria gerada
const exampleQuery = `
SELECT * FROM billing_items 
WHERE user_id = ? 
AND consumption_date BETWEEN '${sqlFormat.startDate}' AND '${sqlFormat.endDate}'
ORDER BY consumption_date;
`;
console.log('\nExemplo de query SQL:');
console.log(exampleQuery);

// Exemplo 6: Tratamento de anos bissextos
console.log('\n=== EXEMPLO 6: Anos Bissextos ===');
const fev2024 = billingPeriodCalculator.calculatePeriod(2024, 2); // Ano bissexto
const fev2023 = billingPeriodCalculator.calculatePeriod(2023, 2); // Ano não bissexto

console.log('Fevereiro 2024 (bissexto):', fev2024.daysInMonth, 'dias');
console.log('Fevereiro 2023 (não bissexto):', fev2023.daysInMonth, 'dias');

// Exemplo 7: Validação de entrada
console.log('\n=== EXEMPLO 7: Validação de Entrada ===');
try {
    billingPeriodCalculator.calculatePeriod(2024, 13); // Mês inválido
} catch (error) {
    console.log('Erro capturado:', error.message);
}

try {
    billingPeriodCalculator.calculatePeriod(2019, 9); // Ano muito antigo
} catch (error) {
    console.log('Erro capturado:', error.message);
}

// Exemplo 8: Uso prático em função de cobrança
console.log('\n=== EXEMPLO 8: Função de Cobrança Corrigida ===');

/**
 * Exemplo de como usar a calculadora em uma função real de cobrança
 */
function gerarCobrancaCorrigida(userId, year, month) {
    try {
        // 1. Calcular período exato
        const period = billingPeriodCalculator.calculatePeriod(year, month);
        console.log(`Gerando cobrança para ${billingPeriodCalculator.formatPeriod(period)}`);
        console.log(`Período: ${billingPeriodCalculator.formatPeriodDetailed(period)}`);
        
        // 2. Simular busca de itens (aqui seria uma query real)
        const todosItens = [
            { tipo: 'venda', data: new Date(2024, 7, 31), valor: 100 }, // Agosto
            { tipo: 'venda', data: new Date(2024, 8, 5), valor: 150 },  // Setembro
            { tipo: 'armazenamento', data: new Date(2024, 8, 10), valor: 50 }, // Setembro
            { tipo: 'servico', data: new Date(2024, 9, 1), valor: 75 }  // Outubro
        ];
        
        // 3. Filtrar apenas itens do período correto
        const itensValidos = todosItens.filter(item => 
            billingPeriodCalculator.isDateInPeriod(item.data, period.startDate, period.endDate)
        );
        
        // 4. Calcular total
        const total = itensValidos.reduce((sum, item) => sum + item.valor, 0);
        
        console.log(`Itens incluídos: ${itensValidos.length}`);
        console.log(`Total da cobrança: R$ ${total}`);
        
        return {
            period,
            items: itensValidos,
            total,
            generatedAt: new Date()
        };
        
    } catch (error) {
        console.error('Erro ao gerar cobrança:', error.message);
        throw error;
    }
}

// Testando a função corrigida
const cobrancaSetembro = gerarCobrancaCorrigida('user123', 2024, 9);
console.log('Cobrança gerada:', cobrancaSetembro);