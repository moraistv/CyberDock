import { BillingPeriodCalculator } from '../src/services/BillingPeriodCalculator.js';

describe('BillingPeriodCalculator', () => {
    let calculator;
    
    beforeEach(() => {
        calculator = new BillingPeriodCalculator();
    });
    
    describe('calculatePeriod', () => {
        test('deve calcular período correto para setembro de 2024', () => {
            const period = calculator.calculatePeriod(2024, 9);
            
            expect(period.year).toBe(2024);
            expect(period.month).toBe(9);
            expect(period.monthName).toBe('Setembro');
            expect(period.daysInMonth).toBe(30);
            
            // Verificar data de início: 01/09/2024 00:00:00.000
            expect(period.startDate.getFullYear()).toBe(2024);
            expect(period.startDate.getMonth()).toBe(8); // JavaScript usa 0-11 para meses
            expect(period.startDate.getDate()).toBe(1);
            expect(period.startDate.getHours()).toBe(0);
            expect(period.startDate.getMinutes()).toBe(0);
            expect(period.startDate.getSeconds()).toBe(0);
            expect(period.startDate.getMilliseconds()).toBe(0);
            
            // Verificar data de fim: 30/09/2024 23:59:59.999
            expect(period.endDate.getFullYear()).toBe(2024);
            expect(period.endDate.getMonth()).toBe(8);
            expect(period.endDate.getDate()).toBe(30);
            expect(period.endDate.getHours()).toBe(23);
            expect(period.endDate.getMinutes()).toBe(59);
            expect(period.endDate.getSeconds()).toBe(59);
            expect(period.endDate.getMilliseconds()).toBe(999);
        });
        
        test('deve calcular período correto para agosto de 2024', () => {
            const period = calculator.calculatePeriod(2024, 8);
            
            expect(period.year).toBe(2024);
            expect(period.month).toBe(8);
            expect(period.monthName).toBe('Agosto');
            expect(period.daysInMonth).toBe(31);
            
            // Agosto tem 31 dias
            expect(period.endDate.getDate()).toBe(31);
        });
        
        test('deve calcular período correto para fevereiro em ano bissexto', () => {
            const period = calculator.calculatePeriod(2024, 2);
            
            expect(period.year).toBe(2024);
            expect(period.month).toBe(2);
            expect(period.monthName).toBe('Fevereiro');
            expect(period.daysInMonth).toBe(29); // 2024 é ano bissexto
            expect(period.isLeapYear).toBe(true);
            
            // Verificar que termina em 29/02
            expect(period.endDate.getDate()).toBe(29);
        });
        
        test('deve calcular período correto para fevereiro em ano não bissexto', () => {
            const period = calculator.calculatePeriod(2023, 2);
            
            expect(period.year).toBe(2023);
            expect(period.month).toBe(2);
            expect(period.daysInMonth).toBe(28); // 2023 não é ano bissexto
            expect(period.isLeapYear).toBe(false);
            
            // Verificar que termina em 28/02
            expect(period.endDate.getDate()).toBe(28);
        });
        
        test('deve calcular período correto para dezembro', () => {
            const period = calculator.calculatePeriod(2024, 12);
            
            expect(period.monthName).toBe('Dezembro');
            expect(period.daysInMonth).toBe(31);
            expect(period.endDate.getDate()).toBe(31);
        });
        
        test('deve calcular período correto para janeiro', () => {
            const period = calculator.calculatePeriod(2024, 1);
            
            expect(period.monthName).toBe('Janeiro');
            expect(period.daysInMonth).toBe(31);
            expect(period.endDate.getDate()).toBe(31);
        });
    });
    
    describe('validatePeriod', () => {
        test('deve aceitar ano e mês válidos', () => {
            expect(() => calculator.validatePeriod(2024, 9)).not.toThrow();
            expect(() => calculator.validatePeriod(2023, 1)).not.toThrow();
            expect(() => calculator.validatePeriod(2025, 12)).not.toThrow();
        });
        
        test('deve rejeitar mês inválido', () => {
            expect(() => calculator.validatePeriod(2024, 0)).toThrow('Mês deve estar entre 1 e 12');
            expect(() => calculator.validatePeriod(2024, 13)).toThrow('Mês deve estar entre 1 e 12');
            expect(() => calculator.validatePeriod(2024, -1)).toThrow('Mês deve estar entre 1 e 12');
        });
        
        test('deve rejeitar ano inválido', () => {
            const currentYear = new Date().getFullYear();
            expect(() => calculator.validatePeriod(2019, 9)).toThrow(`Ano deve estar entre 2020 e ${currentYear + 1}`);
            expect(() => calculator.validatePeriod(currentYear + 2, 9)).toThrow(`Ano deve estar entre 2020 e ${currentYear + 1}`);
        });
        
        test('deve rejeitar valores não inteiros', () => {
            expect(() => calculator.validatePeriod(2024.5, 9)).toThrow('Ano deve ser um número inteiro');
            expect(() => calculator.validatePeriod(2024, 9.5)).toThrow('Mês deve ser um número inteiro');
            expect(() => calculator.validatePeriod('2024', 9)).toThrow('Ano deve ser um número inteiro');
            expect(() => calculator.validatePeriod(2024, '9')).toThrow('Mês deve ser um número inteiro');
        });
    });
    
    describe('isLeapYear', () => {
        test('deve identificar anos bissextos corretamente', () => {
            expect(calculator.isLeapYear(2024)).toBe(true);
            expect(calculator.isLeapYear(2020)).toBe(true);
            expect(calculator.isLeapYear(2000)).toBe(true);
            expect(calculator.isLeapYear(1600)).toBe(true);
        });
        
        test('deve identificar anos não bissextos corretamente', () => {
            expect(calculator.isLeapYear(2023)).toBe(false);
            expect(calculator.isLeapYear(2021)).toBe(false);
            expect(calculator.isLeapYear(1900)).toBe(false);
            expect(calculator.isLeapYear(1700)).toBe(false);
        });
    });
    
    describe('isDateInPeriod', () => {
        test('deve identificar datas dentro do período', () => {
            const period = calculator.calculatePeriod(2024, 9);
            
            // Datas dentro do período
            expect(calculator.isDateInPeriod(
                new Date(2024, 8, 1, 0, 0, 0, 0), 
                period.startDate, 
                period.endDate
            )).toBe(true);
            
            expect(calculator.isDateInPeriod(
                new Date(2024, 8, 15, 12, 30, 0, 0), 
                period.startDate, 
                period.endDate
            )).toBe(true);
            
            expect(calculator.isDateInPeriod(
                new Date(2024, 8, 30, 23, 59, 59, 999), 
                period.startDate, 
                period.endDate
            )).toBe(true);
        });
        
        test('deve identificar datas fora do período', () => {
            const period = calculator.calculatePeriod(2024, 9);
            
            // Datas fora do período
            expect(calculator.isDateInPeriod(
                new Date(2024, 7, 31, 23, 59, 59, 999), // 31/08/2024 23:59:59.999
                period.startDate, 
                period.endDate
            )).toBe(false);
            
            expect(calculator.isDateInPeriod(
                new Date(2024, 9, 1, 0, 0, 0, 0), // 01/10/2024 00:00:00.000
                period.startDate, 
                period.endDate
            )).toBe(false);
        });
        
        test('deve tratar datas inválidas', () => {
            const period = calculator.calculatePeriod(2024, 9);
            
            expect(calculator.isDateInPeriod(
                new Date('invalid'), 
                period.startDate, 
                period.endDate
            )).toBe(false);
            
            expect(calculator.isDateInPeriod(
                null, 
                period.startDate, 
                period.endDate
            )).toBe(false);
        });
    });
    
    describe('getPreviousPeriod', () => {
        test('deve calcular período anterior dentro do mesmo ano', () => {
            const period = calculator.getPreviousPeriod(2024, 9);
            
            expect(period.year).toBe(2024);
            expect(period.month).toBe(8);
            expect(period.monthName).toBe('Agosto');
        });
        
        test('deve calcular período anterior atravessando anos', () => {
            const period = calculator.getPreviousPeriod(2024, 1);
            
            expect(period.year).toBe(2023);
            expect(period.month).toBe(12);
            expect(period.monthName).toBe('Dezembro');
        });
    });
    
    describe('getNextPeriod', () => {
        test('deve calcular próximo período dentro do mesmo ano', () => {
            const period = calculator.getNextPeriod(2024, 8);
            
            expect(period.year).toBe(2024);
            expect(period.month).toBe(9);
            expect(period.monthName).toBe('Setembro');
        });
        
        test('deve calcular próximo período atravessando anos', () => {
            const period = calculator.getNextPeriod(2024, 12);
            
            expect(period.year).toBe(2025);
            expect(period.month).toBe(1);
            expect(period.monthName).toBe('Janeiro');
        });
    });
    
    describe('formatPeriod', () => {
        test('deve formatar período corretamente', () => {
            const period = calculator.calculatePeriod(2024, 9);
            const formatted = calculator.formatPeriod(period);
            
            expect(formatted).toBe('Setembro/2024');
        });
    });
    
    describe('formatPeriodDetailed', () => {
        test('deve formatar período detalhado corretamente', () => {
            const period = calculator.calculatePeriod(2024, 9);
            const formatted = calculator.formatPeriodDetailed(period);
            
            expect(formatted).toBe('01/09/2024 a 30/09/2024');
        });
    });
    
    describe('toSQLFormat', () => {
        test('deve converter período para formato SQL', () => {
            const period = calculator.calculatePeriod(2024, 9);
            const sqlFormat = calculator.toSQLFormat(period);
            
            expect(sqlFormat.startDate).toBe(period.startDate.toISOString());
            expect(sqlFormat.endDate).toBe(period.endDate.toISOString());
            expect(sqlFormat.startDateLocal).toBe('01/09/2024');
            expect(sqlFormat.endDateLocal).toBe('30/09/2024');
        });
    });
    
    describe('Cenários específicos do bug reportado', () => {
        test('setembro deve incluir apenas itens de 01/09 a 30/09', () => {
            const period = calculator.calculatePeriod(2024, 9);
            
            // Itens que NÃO devem ser incluídos
            const itemAgosto = new Date(2024, 7, 31, 23, 59, 59, 999); // 31/08/2024 23:59:59.999
            const itemOutubro = new Date(2024, 9, 1, 0, 0, 0, 0); // 01/10/2024 00:00:00.000
            
            expect(calculator.isDateInPeriod(itemAgosto, period.startDate, period.endDate)).toBe(false);
            expect(calculator.isDateInPeriod(itemOutubro, period.startDate, period.endDate)).toBe(false);
            
            // Itens que DEVEM ser incluídos
            const itemInicio = new Date(2024, 8, 1, 0, 0, 0, 0); // 01/09/2024 00:00:00.000
            const itemMeio = new Date(2024, 8, 15, 12, 0, 0, 0); // 15/09/2024 12:00:00.000
            const itemFim = new Date(2024, 8, 30, 23, 59, 59, 999); // 30/09/2024 23:59:59.999
            
            expect(calculator.isDateInPeriod(itemInicio, period.startDate, period.endDate)).toBe(true);
            expect(calculator.isDateInPeriod(itemMeio, period.startDate, period.endDate)).toBe(true);
            expect(calculator.isDateInPeriod(itemFim, period.startDate, period.endDate)).toBe(true);
        });
        
        test('agosto deve incluir apenas itens de 01/08 a 31/08', () => {
            const period = calculator.calculatePeriod(2024, 8);
            
            // Itens que NÃO devem ser incluídos
            const itemJulho = new Date(2024, 6, 31, 23, 59, 59, 999); // 31/07/2024 23:59:59.999
            const itemSetembro = new Date(2024, 8, 1, 0, 0, 0, 0); // 01/09/2024 00:00:00.000
            
            expect(calculator.isDateInPeriod(itemJulho, period.startDate, period.endDate)).toBe(false);
            expect(calculator.isDateInPeriod(itemSetembro, period.startDate, period.endDate)).toBe(false);
            
            // Itens que DEVEM ser incluídos
            const itemInicio = new Date(2024, 7, 1, 0, 0, 0, 0); // 01/08/2024 00:00:00.000
            const itemFim = new Date(2024, 7, 31, 23, 59, 59, 999); // 31/08/2024 23:59:59.999
            
            expect(calculator.isDateInPeriod(itemInicio, period.startDate, period.endDate)).toBe(true);
            expect(calculator.isDateInPeriod(itemFim, period.startDate, period.endDate)).toBe(true);
        });
    });
});