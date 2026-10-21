import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Recorder, StudentApp } from './App'
import type { Context } from './api'

const context: Context = {
  participant_code: 'P1', invite_status: 'active', consent_confirmed: true,
  participant_info: null, recording_round: 1, attempts: [],
  follow_along_enabled: true, follow_along_interval_seconds: 8,
  study: { id: 'study', title: '任务', text: '第一段。\n第二段。', self_expression_prompt: '介绍自己',
    school_options: [], grade_options: [], class_options: [], text_version: 'v1', instructions: '',
    status: 'open', expected_seconds: 180, min_seconds: 1, max_seconds: 600,
    consent_version: 'v3', created_at: '', updated_at: '' },
}
const onRefresh = async () => {}

describe('student entry and reading', () => {
  it('requires personal information before showing the recorder', () => {
    const html = renderToStaticMarkup(<StudentApp context={context} onRefresh={onRefresh} />)
    expect(html).toContain('填写个人信息')
    expect(html).not.toContain('recorder-panel')
  })
  it('asks returning participants to confirm prefilled information', () => {
    const returning = { ...context, participant_info: { name: '同学甲', school: '学校', grade: '一年级', class_name: '一班', phone: '13800138000', student_number: '001' } }
    const html = renderToStaticMarkup(<StudentApp context={returning} onRefresh={onRefresh} />)
    expect(html).toContain('同学甲')
    expect(html).toContain('保存并继续')
    expect(html).not.toContain('recorder-panel')
  })
  it('renders plain reading text even when the server enables follow-along', () => {
    const html = renderToStaticMarkup(<Recorder context={context} taskType="reading" onRefresh={onRefresh} onEditProfile={() => {}} />)
    expect(html).toContain('第一段。\n第二段。')
    expect(html).not.toMatch(/reading-phrase|follow-status|MiMo|实时定位/)
  })
})
