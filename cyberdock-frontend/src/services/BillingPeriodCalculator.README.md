# BillingPeriodCalculator - Documentação

## Visão Geral

A `BillingPeriodCalculator` é uma classe responsável por calcular períodos exatos de cobrança mensal, garantindo que apenas itens do período correto sejam incluídos na cobrança.

## Problema Resolvido

**Antes:** Cobrança de setembro continha itens de agosto
**Depois:** Cobrança de setembro contém apenas itens de 01/09 00:00:00 até 30/09 23:59:59.999

## Instalação e Uso

```javascript
import { billingPeriodCalculator } from './BillingPeriodCalculator.js';

// Calcular período de setembro 2024
const period = billingPeriodCalculator.calculatePeriod(2024, 9);
console.log(period);
```

## Métodos Principais

### `calculatePeriod(year, month)`

Calcula o período exato de cobrança para um mês específico.

```javascript
const period = billingPeriodCalculator.calculatePeriod(2024, 9);
// Retorna:
{
  startDate: Date(2024-09-01T00:00:00.000Z),
  endDate: Date(2024-09-30T23:59:59.999Z),
  year: 2024,
  month: 9,
  monthName: 'Setembro',
  daysInMonth: 30,
  isLeapYear: true
}
```

### `isDateInPeriod(date, startDate, endDate)`

Verifica se uma data está dentro do período especificado.

```javascript
const period = billingPeriodCalculator.calculatePeriod(2024, 9);
const itemDate = new Date(2024, 8, 15); // 15/09/2024

const isInPeriod = billingPeriodCalculator.isDateInPeriod(
  itemDate, 
  period.startDate, 
  period.endDate
);
// Retorna: true
```

### `formatPeriod(period)` e `formatPeriodDetailed(period)`

Formata períodos para exibição.

```javascript
const period = billingPeriodCalculator.calculatePeriod(2024, 9);

console.log(billingPeriodCalculator.formatPeriod(period));
// Output: "Setembro/2024"

console.log(billingPeriodCalculator.formatPeriodDetailed(period));
// Output: "01/09/2024 a 30/09/2024"
```

### `toSQLFormat(period)`

Converte período para formato adequado para queries SQL.

```javascript
const period = billingPeriodCalculator.calculatePeriod(2024, 9);
const sqlFormat = billingPeriodCalculator.toSQLFormat(period);

// Use em queries SQL
const query = `
  SELECT * FROM billing_items 
  WHERE consumption_date BETWEEN '${sqlFormat.startDate}' AND '${sqlFormat.endDate}'
`;
```

## Exemplo Prático: Corrigindo Cobrança

```javascript
function gerarCobrancaCorrigida(userId, year, month) {
  // 1. Calcular período exato
  const period = billingPeriodCalculator.calculatePeriod(year, month);
  
  // 2. Buscar todos os itens do usuário
  const allItems = await fetchUserItems(userId);
  
  // 3. Filtrar apenas itens do período correto
  const validItems = allItems.filter(item => 
    billingPeriodCalculator.isDateInPeriod(
      item.consumptionDate, 
      period.startDate, 
      period.endDate
    )
  );
  
  // 4. Calcular total
  const total = validItems.reduce((sum, item) => sum + item.amount, 0);
  
  return {
    period: billingPeriodCalculator.formatPeriod(period),
    items: validItems,
    total
  };
}
```

## Casos de Uso por Tipo de Serviço

### Vendas Expedidas
```javascript
// Use shipping_date como data de consumo
const shippingDate = sale.shipping_date || sale.sale_date;
const isInPeriod = billingPeriodCalculator.isDateInPeriod(
  shippingDate, 
  period.startDate, 
  period.endDate
);
```

### Armazenamento
```javascript
// Use storage_period_start como data de consumo
const storageDate = storage.storage_period_start;
const isInPeriod = billingPeriodCalculator.isDateInPeriod(
  storageDate, 
  period.startDate, 
  period.endDate
);
```

### Serviços Avulsos
```javascript
// Use execution_date como data de consumo
const executionDate = service.execution_date;
const isInPeriod = billingPeriodCalculator.isDateInPeriod(
  executionDate, 
  period.startDate, 
  period.endDate
);
```

## Validações

A calculadora inclui validações automáticas:

- **Mês**: Deve estar entre 1 e 12
- **Ano**: Deve estar entre 2020 e ano atual + 1
- **Tipos**: Ano e mês devem ser números inteiros
- **Datas**: Trata datas inválidas retornando `false`

## Tratamento de Anos Bissextos

A calculadora trata automaticamente anos bissextos:

```javascript
const fev2024 = billingPeriodCalculator.calculatePeriod(2024, 2);
console.log(fev2024.daysInMonth); // 29 (ano bissexto)

const fev2023 = billingPeriodCalculator.calculatePeriod(2023, 2);
console.log(fev2023.daysInMonth); // 28 (ano não bissexto)
```

## Navegação entre Períodos

```javascript
const current = billingPeriodCalculator.calculatePeriod(2024, 9);
const previous = billingPeriodCalculator.getPreviousPeriod(2024, 9);
const next = billingPeriodCalculator.getNextPeriod(2024, 9);

console.log(billingPeriodCalculator.formatPeriod(previous)); // "Agosto/2024"
console.log(billingPeriodCalculator.formatPeriod(current));  // "Setembro/2024"
console.log(billingPeriodCalculator.formatPeriod(next));     // "Outubro/2024"
```

## Testes

Execute os testes para verificar o funcionamento:

```bash
# Se tiver Jest configurado
npm test BillingPeriodCalculator.test.js

# Ou execute o exemplo
node src/services/BillingPeriodCalculator.example.js
```

## Cenários de Teste Específicos

A calculadora foi testada especificamente para resolver o bug reportado:

```javascript
// Cenário: Cobrança de setembro não deve incluir itens de agosto
const period = billingPeriodCalculator.calculatePeriod(2024, 9);

// Item de agosto (NÃO deve ser incluído)
const itemAgosto = new Date(2024, 7, 31, 23, 59, 59, 999);
console.log(billingPeriodCalculator.isDateInPeriod(itemAgosto, period.startDate, period.endDate)); // false

// Item de setembro (DEVE ser incluído)
const itemSetembro = new Date(2024, 8, 1, 0, 0, 0, 0);
console.log(billingPeriodCalculator.isDateInPeriod(itemSetembro, period.startDate, period.endDate)); // true
```

## Integração com Sistema Existente

Para integrar com o sistema atual:

1. **Importe a calculadora** nos módulos de cobrança
2. **Substitua cálculos manuais** de período pela calculadora
3. **Use `isDateInPeriod`** para filtrar itens
4. **Aplique `toSQLFormat`** em queries de banco de dados
5. **Adicione logs** usando os métodos de formatação

## Performance

- **Cálculos rápidos**: Operações matemáticas simples
- **Cache recomendado**: Para períodos fechados
- **Validação eficiente**: Falha rápida para entradas inválidas
- **Memória baixa**: Não mantém estado interno