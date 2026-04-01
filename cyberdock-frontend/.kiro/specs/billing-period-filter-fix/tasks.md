# Implementation Plan - Correção do Filtro de Período na Cobrança

## Tarefas de Implementação

- [x] 1. Implementar calculadora de período de cobrança



  - Criar classe BillingPeriodCalculator com método para calcular período exato do mês
  - Implementar validação de ano e mês válidos
  - Garantir que período seja de 00:00:00 do dia 1º até 23:59:59 do último dia do mês
  - Criar testes unitários para diferentes meses e anos, incluindo anos bissextos


  - _Requirements: 1.1, 4.1, 4.2, 4.3_

- [ ] 2. Criar sistema de resolução de data de consumo
  - Implementar classe ConsumptionDateResolver para determinar data correta por tipo de item
  - Definir prioridade: data de expedição > data de venda para vendas
  - Definir data de início do período para armazenamento



  - Definir data de execução para serviços avulsos
  - Implementar fallback para itens sem data específica
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 3. Corrigir queries de banco de dados para vendas expedidas
  - Modificar query de vendas para usar shipping_date como critério principal
  - Implementar fallback para sale_date quando shipping_date não disponível
  - Adicionar filtro WHERE com período exato calculado
  - Criar índices otimizados para campos de data
  - Testar performance com grandes volumes de dados
  - _Requirements: 1.1, 2.1_

- [ ] 4. Corrigir queries de banco de dados para armazenamento
  - Modificar query de armazenamento para usar storage_period_start
  - Implementar lógica para serviços que atravessam múltiplos meses
  - Garantir que apenas armazenamento ativo no período seja incluído
  - Adicionar tratamento para períodos de armazenamento em aberto
  - _Requirements: 1.1, 2.2_

- [ ] 5. Corrigir queries de banco de dados para serviços avulsos
  - Modificar query de serviços para usar execution_date
  - Implementar filtro rigoroso por período de execução
  - Adicionar validação para serviços sem data de execução
  - Criar fallback para created_at quando execution_date não disponível
  - _Requirements: 1.1, 2.3_

- [ ] 6. Implementar sistema de logs e auditoria
  - Criar classe BillingAuditLogger para registrar processo de cobrança
  - Implementar log de período utilizado para cada geração de cobrança
  - Registrar contagem de itens incluídos/excluídos por categoria
  - Adicionar warnings para inconsistências de data detectadas
  - Criar dashboard para monitoramento de logs de cobrança
  - _Requirements: 6.1, 6.2, 6.3_

- [ ] 7. Criar ferramenta de recálculo de cobranças históricas
  - Implementar interface para seleção de período a recalcular
  - Criar processo de backup de cobrança original antes do recálculo
  - Implementar comparação entre cobrança antiga e nova
  - Adicionar relatório de diferenças encontradas
  - Criar processo de aprovação para aplicar correções
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 8. Implementar validações de consistência temporal
  - Criar validador para verificar se todos os itens estão no período correto
  - Implementar verificação de integridade antes de gerar cobrança
  - Adicionar alertas automáticos para discrepâncias detectadas
  - Criar relatório de itens com datas inconsistentes
  - _Requirements: 4.3, 6.3_

- [ ] 9. Criar testes de integração para fluxo completo
  - Implementar teste end-to-end de geração de cobrança
  - Criar cenários de teste com dados de múltiplos meses
  - Testar comportamento em períodos limítrofes (início/fim do mês)
  - Validar que itens de agosto não aparecem na cobrança de setembro
  - Testar recálculo de cobranças históricas
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 10. Implementar sistema de cache para períodos fechados
  - Criar cache para cobranças de meses já finalizados
  - Implementar invalidação de cache quando dados são corrigidos
  - Adicionar configuração para TTL do cache
  - Otimizar performance para consultas de períodos antigos
  - _Requirements: Performance e otimização_

- [ ] 11. Criar interface de administração para auditoria
  - Implementar tela para visualizar logs de cobrança por período
  - Criar relatório de itens por categoria e período
  - Adicionar funcionalidade de exportação de dados para auditoria
  - Implementar filtros por cliente, período e tipo de serviço
  - _Requirements: 5.3, 6.1_

- [ ] 12. Implementar migração gradual e rollback
  - Criar feature flag para ativar/desativar novo sistema
  - Implementar modo de comparação (executar ambos os sistemas)
  - Adicionar métricas de diferenças entre sistema antigo e novo
  - Criar processo de rollback em caso de problemas
  - Documentar procedimento de migração
  - _Requirements: Estratégia de migração_

- [ ] 13. Criar documentação e treinamento
  - Documentar novo processo de geração de cobrança
  - Criar guia de troubleshooting para problemas de período
  - Implementar help tooltips na interface de cobrança
  - Criar manual de uso da ferramenta de recálculo
  - _Requirements: Documentação e usabilidade_

- [ ] 14. Implementar monitoramento e alertas
  - Criar métricas de tempo de geração de cobrança
  - Implementar alertas para cobranças com discrepâncias
  - Adicionar monitoramento de performance das queries
  - Criar dashboard de saúde do sistema de cobrança
  - _Requirements: Monitoramento e observabilidade_

- [ ] 15. Executar testes de aceitação com dados reais
  - Testar com dados reais de clientes específicos (Mimale, Lupe Migo)
  - Validar que problema reportado foi corrigido
  - Executar testes de regressão em cobranças existentes corretas
  - Obter aprovação dos usuários finais
  - Documentar casos de teste executados
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_