/**
 * Resolução de Data de Consumo
 * 
 * Responsável por determinar a data correta de consumo para diferentes
 * tipos de itens de cobrança, garantindo que cada item seja cobrado
 * no período correto baseado em quando foi realmente consumido/executado.
 */
export class ConsumptionDateResolver {
    /**
     * Resolve a data de consumo para um item baseado no seu tipo
     * @param {Object} item - Item de cobrança
     * @returns {Date|null} Data de consumo ou null se não puder determinar
     */
    resolveConsumptionDate(item) {
        if (!item || typeof item !== 'object') {
            console.warn('Item inválido fornecido para resolução de data:', item);
            return null;
        }

        // Determinar tipo do item
        const itemType = this.determineItemType(item);
        
        switch (itemType) {
            case 'SALE':
                return this.resolveSaleConsumptionDate(item);
            case 'STORAGE':
                return this.resolveStorageConsumptionDate(item);
            case 'SERVICE':
                return this.resolveServiceConsumptionDate(item);
            default:
                return this.resolveFallbackConsumptionDate(item);
        }
    }

    /**
     * Determina o tipo do item baseado em suas propriedades
     * @param {Object} item - Item a ser analisado
     * @returns {string} Tipo do item ('SALE', 'STORAGE', 'SERVICE', 'UNKNOWN')
     */
    determineItemType(item) {
        // Verificar se é uma venda
        if (item.sale_date || item.shipping_date || item.order_id || item.product_title) {
            return 'SALE';
        }
        
        // Verificar se é armazenamento
        if (item.storage_period_start || item.storage_period_end || item.storage_volume) {
            return 'STORAGE';
        }
        
        // Verificar se é serviço
        if (item.execution_date || item.service_type || item.service_description) {
            return 'SERVICE';
        }
        
        // Verificar por campos genéricos que podem indicar o tipo
        if (item.type) {
            const type = item.type.toUpperCase();
            if (['SALE', 'VENDA', 'ORDER', 'PEDIDO'].includes(type)) return 'SALE';
            if (['STORAGE', 'ARMAZENAMENTO', 'ESTOQUE'].includes(type)) return 'STORAGE';
            if (['SERVICE', 'SERVICO', 'SERVIÇO'].includes(type)) return 'SERVICE';
        }
        
        return 'UNKNOWN';
    }

    /**
     * Resolve data de consumo para vendas
     * Prioridade: shipping_date > sale_date > created_at
     * @param {Object} sale - Item de venda
     * @returns {Date|null} Data de consumo da venda
     */
    resolveSaleConsumptionDate(sale) {
        // Prioridade 1: Data de expedição (quando o produto foi realmente enviado)
        if (sale.shipping_date) {
            const shippingDate = this.parseDate(sale.shipping_date);
            if (shippingDate) {
                return shippingDate;
            }
        }

        // Prioridade 2: Data da venda (quando a venda foi realizada)
        if (sale.sale_date) {
            const saleDate = this.parseDate(sale.sale_date);
            if (saleDate) {
                return saleDate;
            }
        }

        // Prioridade 3: Data de processamento (quando foi processada)
        if (sale.processed_at) {
            const processedDate = this.parseDate(sale.processed_at);
            if (processedDate) {
                return processedDate;
            }
        }

        // Fallback: Data de criação
        if (sale.created_at) {
            const createdDate = this.parseDate(sale.created_at);
            if (createdDate) {
                return createdDate;
            }
        }

        console.warn('Não foi possível determinar data de consumo para venda:', sale.id || 'ID não disponível');
        return null;
    }

    /**
     * Resolve data de consumo para armazenamento
     * Usa storage_period_start como data de início do consumo
     * @param {Object} storage - Item de armazenamento
     * @returns {Date|null} Data de consumo do armazenamento
     */
    resolveStorageConsumptionDate(storage) {
        // Prioridade 1: Data de início do período de armazenamento
        if (storage.storage_period_start) {
            const startDate = this.parseDate(storage.storage_period_start);
            if (startDate) {
                return startDate;
            }
        }

        // Prioridade 2: Data de entrada no estoque
        if (storage.entry_date) {
            const entryDate = this.parseDate(storage.entry_date);
            if (entryDate) {
                return entryDate;
            }
        }

        // Fallback: Data de criação
        if (storage.created_at) {
            const createdDate = this.parseDate(storage.created_at);
            if (createdDate) {
                return createdDate;
            }
        }

        console.warn('Não foi possível determinar data de consumo para armazenamento:', storage.id || 'ID não disponível');
        return null;
    }

    /**
     * Resolve data de consumo para serviços avulsos
     * Usa execution_date como data de execução do serviço
     * @param {Object} service - Item de serviço
     * @returns {Date|null} Data de consumo do serviço
     */
    resolveServiceConsumptionDate(service) {
        // Prioridade 1: Data de execução do serviço
        if (service.execution_date) {
            const executionDate = this.parseDate(service.execution_date);
            if (executionDate) {
                return executionDate;
            }
        }

        // Prioridade 2: Data de conclusão
        if (service.completed_at) {
            const completedDate = this.parseDate(service.completed_at);
            if (completedDate) {
                return completedDate;
            }
        }

        // Prioridade 3: Data de início
        if (service.started_at) {
            const startedDate = this.parseDate(service.started_at);
            if (startedDate) {
                return startedDate;
            }
        }

        // Fallback: Data de criação
        if (service.created_at) {
            const createdDate = this.parseDate(service.created_at);
            if (createdDate) {
                return createdDate;
            }
        }

        console.warn('Não foi possível determinar data de consumo para serviço:', service.id || 'ID não disponível');
        return null;
    }

    /**
     * Resolve data de consumo para itens de tipo desconhecido
     * @param {Object} item - Item desconhecido
     * @returns {Date|null} Data de consumo ou null
     */
    resolveFallbackConsumptionDate(item) {
        // Tentar campos comuns de data
        const commonDateFields = [
            'consumption_date',
            'execution_date',
            'service_date',
            'billing_date',
            'processed_at',
            'completed_at',
            'updated_at',
            'created_at'
        ];

        for (const field of commonDateFields) {
            if (item[field]) {
                const date = this.parseDate(item[field]);
                if (date) {
                    return date;
                }
            }
        }

        console.warn('Não foi possível determinar data de consumo para item desconhecido:', item);
        return null;
    }

    /**
     * Faz parsing seguro de uma data
     * @param {string|Date|number} dateValue - Valor da data
     * @returns {Date|null} Data parseada ou null se inválida
     */
    parseDate(dateValue) {
        if (!dateValue) {
            return null;
        }

        // Se já é uma instância de Date
        if (dateValue instanceof Date) {
            return isNaN(dateValue.getTime()) ? null : dateValue;
        }

        // Se é um timestamp numérico
        if (typeof dateValue === 'number') {
            const date = new Date(dateValue);
            return isNaN(date.getTime()) ? null : date;
        }

        // Se é uma string
        if (typeof dateValue === 'string') {
            // Tentar parsing direto
            let date = new Date(dateValue);
            if (!isNaN(date.getTime())) {
                return date;
            }

            // Tentar formato brasileiro DD/MM/YYYY
            const brDateMatch = dateValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (brDateMatch) {
                const [, day, month, year] = brDateMatch;
                date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }

            // Tentar formato DD/MM/YYYY HH:mm:ss
            const brDateTimeMatch = dateValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
            if (brDateTimeMatch) {
                const [, day, month, year, hour, minute, second] = brDateTimeMatch;
                date = new Date(
                    parseInt(year), 
                    parseInt(month) - 1, 
                    parseInt(day),
                    parseInt(hour),
                    parseInt(minute),
                    parseInt(second)
                );
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }
        }

        return null;
    }

    /**
     * Valida se uma data de consumo é razoável
     * @param {Date} date - Data a ser validada
     * @returns {boolean} True se a data é válida
     */
    isValidConsumptionDate(date) {
        if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
            return false;
        }

        const now = new Date();
        const minDate = new Date(2020, 0, 1); // 01/01/2020
        const maxDate = new Date(now.getFullYear() + 1, 11, 31); // 31/12 do próximo ano

        return date >= minDate && date <= maxDate;
    }

    /**
     * Resolve data de consumo com validação
     * @param {Object} item - Item de cobrança
     * @returns {Object} Resultado com data e informações de debug
     */
    resolveWithValidation(item) {
        const consumptionDate = this.resolveConsumptionDate(item);
        const isValid = this.isValidConsumptionDate(consumptionDate);
        const itemType = this.determineItemType(item);

        return {
            consumptionDate,
            isValid,
            itemType,
            itemId: item.id || 'N/A',
            fallbackUsed: itemType === 'UNKNOWN',
            debugInfo: {
                availableFields: Object.keys(item).filter(key => 
                    key.includes('date') || key.includes('_at') || key === 'type'
                ),
                resolvedFrom: this.getResolvedFromField(item, itemType)
            }
        };
    }

    /**
     * Identifica de qual campo a data foi resolvida
     * @param {Object} item - Item analisado
     * @param {string} itemType - Tipo do item
     * @returns {string} Nome do campo usado
     */
    getResolvedFromField(item, itemType) {
        switch (itemType) {
            case 'SALE':
                if (item.shipping_date && this.parseDate(item.shipping_date)) return 'shipping_date';
                if (item.sale_date && this.parseDate(item.sale_date)) return 'sale_date';
                if (item.processed_at && this.parseDate(item.processed_at)) return 'processed_at';
                if (item.created_at && this.parseDate(item.created_at)) return 'created_at';
                break;
            case 'STORAGE':
                if (item.storage_period_start && this.parseDate(item.storage_period_start)) return 'storage_period_start';
                if (item.entry_date && this.parseDate(item.entry_date)) return 'entry_date';
                if (item.created_at && this.parseDate(item.created_at)) return 'created_at';
                break;
            case 'SERVICE':
                if (item.execution_date && this.parseDate(item.execution_date)) return 'execution_date';
                if (item.completed_at && this.parseDate(item.completed_at)) return 'completed_at';
                if (item.started_at && this.parseDate(item.started_at)) return 'started_at';
                if (item.created_at && this.parseDate(item.created_at)) return 'created_at';
                break;
        }
        return 'unknown';
    }

    /**
     * Processa uma lista de itens resolvendo datas de consumo
     * @param {Array} items - Lista de itens
     * @returns {Array} Itens com datas de consumo resolvidas
     */
    processItemsList(items) {
        if (!Array.isArray(items)) {
            console.warn('Lista de itens inválida fornecida');
            return [];
        }

        return items.map(item => {
            const resolution = this.resolveWithValidation(item);
            return {
                ...item,
                consumptionDate: resolution.consumptionDate,
                consumptionDateResolution: resolution
            };
        });
    }

    /**
     * Gera relatório de resolução de datas para debug
     * @param {Array} items - Lista de itens processados
     * @returns {Object} Relatório de resolução
     */
    generateResolutionReport(items) {
        const processedItems = this.processItemsList(items);
        
        const report = {
            totalItems: processedItems.length,
            successfulResolutions: 0,
            failedResolutions: 0,
            byType: {
                SALE: 0,
                STORAGE: 0,
                SERVICE: 0,
                UNKNOWN: 0
            },
            byResolvedField: {},
            invalidDates: [],
            summary: []
        };

        processedItems.forEach(item => {
            const resolution = item.consumptionDateResolution;
            
            if (resolution.isValid) {
                report.successfulResolutions++;
            } else {
                report.failedResolutions++;
                report.invalidDates.push({
                    itemId: resolution.itemId,
                    itemType: resolution.itemType,
                    consumptionDate: resolution.consumptionDate
                });
            }

            report.byType[resolution.itemType]++;
            
            const resolvedFrom = resolution.debugInfo.resolvedFrom;
            report.byResolvedField[resolvedFrom] = (report.byResolvedField[resolvedFrom] || 0) + 1;
        });

        report.summary = [
            `Total de itens processados: ${report.totalItems}`,
            `Resoluções bem-sucedidas: ${report.successfulResolutions}`,
            `Resoluções falharam: ${report.failedResolutions}`,
            `Taxa de sucesso: ${((report.successfulResolutions / report.totalItems) * 100).toFixed(1)}%`
        ];

        return report;
    }
}

// Instância singleton para uso global
export const consumptionDateResolver = new ConsumptionDateResolver();

// Export default para compatibilidade
export default ConsumptionDateResolver;