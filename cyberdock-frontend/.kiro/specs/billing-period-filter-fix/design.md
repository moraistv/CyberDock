# Design Document - Correção do Filtro de Período na Cobrança

## Overview

Este documento descreve o design da solução para corrigir o bug no sistema de cobrança onde itens de períodos incorretos estão sendo incluídos na cobrança mensal. A solução envolve a correção dos filtros de data em consultas de banco de dados, padronização do campo de data utilizado para filtro, e implementação de validações para garantir a consistência temporal.

## Architecture

### Componentes Afetados

1. **Billing Service** - Serviço principal de cobrança
2. **Database Queries** - Consultas que recuperam itens para cobrança
3. **Date Filter Logic** - Lógica de filtro por período
4. **Billing Report Generator** - Gerador de relatórios de cobrança
5. **Audit Service** - Serviço de auditoria e logs

### Fluxo de Dados Atual vs. Proposto

**Fluxo Atual (Problemático):**
```
Seleção do Mês → Query Genérica → Itens Misturados → Cobrança Incorreta
```

**Fluxo Proposto (Corrigido):**
```
Seleção do Mês → Cálculo Período Exato → Query com Filtro Correto → Validação → Cobrança Correta
```

## Components and Interfaces

### 1. BillingPeriodCalculator

**Responsabilidade:** Calcular períodos exatos de cobrança

```javascript
class BillingPeriodCalculator {
    calculatePeriod(year, month) {
        const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);
        return { startDate, endDate };
    }
    
    validatePeriod(startDate, endDate) {
        // Validações de período
    }
}
```

### 2. BillingItemFilter

**Responsabilidade:** Filtrar itens por período de consumo

```javascript
class BillingItemFilter {
    filterByConsumptionPeriod(items, startDate, endDate) {
        return items.filter(item => {
            const consumptionDate = this.getConsumptionDate(item);
            return consumptionDate >= startDate && consumptionDate <= endDate;
        });
    }
    
    getConsumptionDate(item) {
        // Lógica para determinar data de consumo baseada no tipo de item
        switch(item.type) {
            case 'SALE': return item.shipping_date || item.sale_date;
            case 'STORAGE': return item.storage_period_start;
            case 'SERVICE': return item.execution_date;
            default: return item.created_at;
        }
    }
}
```

### 3. BillingQueryBuilder

**Responsabilidade:** Construir queries com filtros corretos

```javascript
class BillingQueryBuilder {
    buildSalesQuery(userId, startDate, endDate) {
        return `
            SELECT * FROM sales 
            WHERE user_id = ? 
            AND (shipping_date BETWEEN ? AND ? OR 
                 (shipping_date IS NULL AND sale_date BETWEEN ? AND ?))
        `;
    }
    
    buildStorageQuery(userId, startDate, endDate) {
        return `
            SELECT * FROM storage_services 
            WHERE user_id = ? 
            AND storage_period_start <= ? 
            AND (storage_period_end >= ? OR storage_period_end IS NULL)
        `;
    }
    
    buildServicesQuery(userId, startDate, endDate) {
        return `
            SELECT * FROM additional_services 
            WHERE user_id = ? 
            AND execution_date BETWEEN ? AND ?
        `;
    }
}
```

### 4. BillingAuditLogger

**Responsabilidade:** Registrar logs detalhados do processo

```javascript
class BillingAuditLogger {
    logBillingGeneration(userId, period, itemCounts) {
        const logEntry = {
            userId,
            period,
            timestamp: new Date(),
            itemCounts,
            action: 'BILLING_GENERATED'
        };
        this.writeLog(logEntry);
    }
    
    logPeriodFilter(originalCount, filteredCount, period) {
        // Log de filtros aplicados
    }
}
```

## Data Models

### BillingPeriod

```javascript
{
    year: number,
    month: number,
    startDate: Date,
    endDate: Date,
    timezone: string
}
```

### BillingItem

```javascript
{
    id: string,
    userId: string,
    type: 'SALE' | 'STORAGE' | 'SERVICE',
    consumptionDate: Date,
    createdDate: Date,
    amount: number,
    description: string,
    metadata: object
}
```

### BillingReport

```javascript
{
    userId: string,
    period: BillingPeriod,
    items: BillingItem[],
    totalAmount: number,
    itemCounts: {
        sales: number,
        storage: number,
        services: number
    },
    generatedAt: Date,
    version: string
}
```

## Error Handling

### 1. Validação de Período

```javascript
class PeriodValidator {
    validatePeriod(year, month) {
        if (month < 1 || month > 12) {
            throw new InvalidPeriodError('Mês deve estar entre 1 e 12');
        }
        
        if (year < 2020 || year > new Date().getFullYear() + 1) {
            throw new InvalidPeriodError('Ano fora do intervalo válido');
        }
    }
}
```

### 2. Tratamento de Datas Inválidas

```javascript
class DateHandler {
    safeParseDate(dateString) {
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                throw new InvalidDateError(`Data inválida: ${dateString}`);
            }
            return date;
        } catch (error) {
            this.logger.warn(`Erro ao parsear data: ${dateString}`, error);
            return null;
        }
    }
}
```

### 3. Fallback para Itens sem Data de Consumo

```javascript
class ConsumptionDateResolver {
    resolveConsumptionDate(item) {
        // Prioridade: data específica > data de criação > data atual
        return item.consumptionDate || 
               item.executionDate || 
               item.shippingDate || 
               item.createdAt || 
               new Date();
    }
}
```

## Testing Strategy

### 1. Testes Unitários

- **BillingPeriodCalculator**: Testar cálculo correto de períodos para diferentes meses/anos
- **BillingItemFilter**: Testar filtro por diferentes tipos de data de consumo
- **BillingQueryBuilder**: Testar geração de queries SQL corretas
- **DateHandler**: Testar parsing e validação de datas

### 2. Testes de Integração

- **Fluxo Completo**: Testar geração de cobrança do início ao fim
- **Múltiplos Tipos de Item**: Testar com vendas, armazenamento e serviços
- **Períodos Limítrofes**: Testar itens no início/fim do mês
- **Dados Históricos**: Testar com dados de meses anteriores

### 3. Testes de Regressão

- **Cobranças Existentes**: Verificar que cobranças corretas não são afetadas
- **Performance**: Garantir que correções não impactem performance
- **Compatibilidade**: Testar com diferentes formatos de data existentes

### 4. Cenários de Teste Específicos

```javascript
describe('Billing Period Filter', () => {
    test('Setembro deve incluir apenas itens de 01/09 a 30/09', () => {
        const items = [
            { id: 1, consumptionDate: '2024-08-31T23:59:59' }, // Não deve incluir
            { id: 2, consumptionDate: '2024-09-01T00:00:00' }, // Deve incluir
            { id: 3, consumptionDate: '2024-09-15T12:00:00' }, // Deve incluir
            { id: 4, consumptionDate: '2024-09-30T23:59:59' }, // Deve incluir
            { id: 5, consumptionDate: '2024-10-01T00:00:00' }  // Não deve incluir
        ];
        
        const filtered = billingService.generateBilling(userId, 2024, 9);
        expect(filtered.items).toHaveLength(3);
        expect(filtered.items.map(i => i.id)).toEqual([2, 3, 4]);
    });
});
```

## Migration Strategy

### 1. Fase 1: Implementação da Correção

- Implementar novos filtros de período
- Adicionar logs detalhados
- Manter compatibilidade com sistema atual

### 2. Fase 2: Validação e Testes

- Executar testes em ambiente de desenvolvimento
- Comparar resultados antigos vs. novos
- Validar com dados reais de clientes

### 3. Fase 3: Deploy Gradual

- Deploy em ambiente de staging
- Testes com usuários beta
- Monitoramento de performance e logs

### 4. Fase 4: Correção Retroativa

- Ferramenta para recalcular cobranças históricas
- Interface para auditoria de diferenças
- Processo de aprovação para correções

## Performance Considerations

### 1. Otimização de Queries

- Índices em campos de data de consumo
- Particionamento de tabelas por período
- Cache de resultados para períodos fechados

### 2. Processamento em Lote

- Processamento assíncrono para grandes volumes
- Paginação para consultas grandes
- Timeout configurável para operações longas

### 3. Monitoramento

- Métricas de tempo de geração de cobrança
- Alertas para discrepâncias de período
- Dashboard de saúde do sistema de cobrança