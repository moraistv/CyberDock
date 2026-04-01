/**
 * Calculadora de Período de Cobrança
 * 
 * Responsável por calcular períodos exatos de cobrança mensal,
 * garantindo que o período seja sempre do dia 1º às 00:00:00
 * até o último dia do mês às 23:59:59.999
 */
export class BillingPeriodCalculator {
    /**
     * Calcula o período exato de cobrança para um mês específico
     * @param {number} year - Ano (ex: 2024)
     * @param {number} month - Mês (1-12)
     * @returns {Object} Objeto com startDate e endDate
     * @throws {Error} Se ano ou mês forem inválidos
     */
    calculatePeriod(year, month) {
        this.validatePeriod(year, month);
        
        // Data de início: 1º dia do mês às 00:00:00.000
        const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
        
        // Data de fim: último dia do mês às 23:59:59.999
        // Usando new Date(year, month, 0) para obter o último dia do mês anterior
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);
        
        return {
            startDate,
            endDate,
            year,
            month,
            monthName: this.getMonthName(month),
            daysInMonth: endDate.getDate(),
            isLeapYear: this.isLeapYear(year)
        };
    }
    
    /**
     * Valida se o ano e mês são válidos
     * @param {number} year - Ano a ser validado
     * @param {number} month - Mês a ser validado (1-12)
     * @throws {Error} Se ano ou mês forem inválidos
     */
    validatePeriod(year, month) {
        if (!Number.isInteger(year)) {
            throw new Error('Ano deve ser um número inteiro');
        }
        
        if (!Number.isInteger(month)) {
            throw new Error('Mês deve ser um número inteiro');
        }
        
        if (month < 1 || month > 12) {
            throw new Error('Mês deve estar entre 1 e 12');
        }
        
        const currentYear = new Date().getFullYear();
        if (year < 2020 || year > currentYear + 1) {
            throw new Error(`Ano deve estar entre 2020 e ${currentYear + 1}`);
        }
    }
    
    /**
     * Verifica se um ano é bissexto
     * @param {number} year - Ano a ser verificado
     * @returns {boolean} True se for ano bissexto
     */
    isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    }
    
    /**
     * Retorna o nome do mês em português
     * @param {number} month - Número do mês (1-12)
     * @returns {string} Nome do mês
     */
    getMonthName(month) {
        const months = [
            'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
            'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
        ];
        return months[month - 1];
    }
    
    /**
     * Verifica se uma data está dentro do período especificado
     * @param {Date} date - Data a ser verificada
     * @param {Date} startDate - Data de início do período
     * @param {Date} endDate - Data de fim do período
     * @returns {boolean} True se a data estiver dentro do período
     */
    isDateInPeriod(date, startDate, endDate) {
        if (!(date instanceof Date) || isNaN(date.getTime())) {
            return false;
        }
        
        return date >= startDate && date <= endDate;
    }
    
    /**
     * Calcula o período atual (mês corrente)
     * @returns {Object} Período do mês atual
     */
    getCurrentPeriod() {
        const now = new Date();
        return this.calculatePeriod(now.getFullYear(), now.getMonth() + 1);
    }
    
    /**
     * Calcula o período anterior ao especificado
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Período do mês anterior
     */
    getPreviousPeriod(year, month) {
        let prevYear = year;
        let prevMonth = month - 1;
        
        if (prevMonth < 1) {
            prevMonth = 12;
            prevYear = year - 1;
        }
        
        return this.calculatePeriod(prevYear, prevMonth);
    }
    
    /**
     * Calcula o próximo período ao especificado
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Período do próximo mês
     */
    getNextPeriod(year, month) {
        let nextYear = year;
        let nextMonth = month + 1;
        
        if (nextMonth > 12) {
            nextMonth = 1;
            nextYear = year + 1;
        }
        
        return this.calculatePeriod(nextYear, nextMonth);
    }
    
    /**
     * Formata um período para exibição
     * @param {Object} period - Período calculado
     * @returns {string} Período formatado (ex: "Setembro/2024")
     */
    formatPeriod(period) {
        return `${period.monthName}/${period.year}`;
    }
    
    /**
     * Formata um período para exibição detalhada
     * @param {Object} period - Período calculado
     * @returns {string} Período formatado detalhado
     */
    formatPeriodDetailed(period) {
        const startFormatted = period.startDate.toLocaleDateString('pt-BR');
        const endFormatted = period.endDate.toLocaleDateString('pt-BR');
        return `${startFormatted} a ${endFormatted}`;
    }
    
    /**
     * Converte período para formato de query SQL
     * @param {Object} period - Período calculado
     * @returns {Object} Objeto com startDate e endDate em formato ISO
     */
    toSQLFormat(period) {
        return {
            startDate: period.startDate.toISOString(),
            endDate: period.endDate.toISOString(),
            startDateLocal: period.startDate.toLocaleDateString('pt-BR'),
            endDateLocal: period.endDate.toLocaleDateString('pt-BR')
        };
    }
}

// Instância singleton para uso global
export const billingPeriodCalculator = new BillingPeriodCalculator();

// Export default para compatibilidade
export default BillingPeriodCalculator;