import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog';
import { ProviderConnection, type ConnectionDrafts } from '../models/ProviderConnection';
import type { ModelController } from '../models/use-model-settings';
import { AgentConfigSettings } from '../agent-config/AgentConfigSettings';
import { useAgentConfig } from '../agent-config/use-agent-config';
import { agentConfigSchema } from '../../../shared/agent-config';
import { LocalSettings } from './LocalSettings';

export function SettingsDialog({
  open,
  onOpenChange,
  modelSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelSettings: ModelController;
}) {
  const [drafts, setDrafts] = useState<ConnectionDrafts>({});
  const [section, setSection] = useState('models');
  const [confirmClose, setConfirmClose] = useState(false);
  const config = useAgentConfig(open);
  const valid = !!config.draft && agentConfigSchema.safeParse(config.draft).success;
  function changeOpen(next: boolean) {
    if (!next && config.busy) return;
    if (!next && config.dirty) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(next);
  }
  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="settings-dialog">
          <header className="settings-header">
            <DialogTitle className="text-xl font-semibold">设置</DialogTitle>
            <DialogDescription className="mt-2 text-sm text-muted-foreground">
              管理模型、Agent 与本地工作环境
            </DialogDescription>
            {section === 'models' && modelSettings.error && (
              <p role="alert" className="maintenance-error">
                {modelSettings.error}
              </p>
            )}
          </header>
          <Tabs.Root
            className="settings-layout"
            value={section}
            onValueChange={setSection}
            orientation="vertical"
          >
            <Tabs.List className="settings-navigation" aria-label="设置分类">
              <Tabs.Trigger value="models">模型与连接</Tabs.Trigger>
              <Tabs.Trigger value="agent">Agent 配置</Tabs.Trigger>
              <Tabs.Trigger value="local">本地与诊断</Tabs.Trigger>
            </Tabs.List>
            <div className="settings-body">
              <Tabs.Content value="models" className="settings-page">
                {!modelSettings.value ? (
                  modelSettings.error ? (
                    <Button
                      variant="outline"
                      disabled={modelSettings.busy}
                      onClick={() => void modelSettings.reload()}
                    >
                      重新加载模型设置
                    </Button>
                  ) : (
                    <p role="status">正在加载模型设置…</p>
                  )
                ) : (
                  <ProviderConnection
                    controller={modelSettings}
                    drafts={drafts}
                    setDrafts={setDrafts}
                  />
                )}
              </Tabs.Content>
              <Tabs.Content value="agent" className="settings-page">
                <AgentConfigSettings controller={config} />
              </Tabs.Content>
              <Tabs.Content value="local" className="settings-page">
                <LocalSettings />
              </Tabs.Content>
            </div>
          </Tabs.Root>
          {config.dirty && (
            <footer className="config-save-bar">
              <span>Agent 配置有未保存的修改</span>
              <Button variant="ghost" disabled={config.busy} onClick={config.reset}>
                撤销修改
              </Button>
              <Button
                disabled={config.busy || !valid}
                onClick={() => {
                  setSection('agent');
                  void config.save();
                }}
              >
                {config.busy ? '正在保存…' : '保存配置'}
              </Button>
            </footer>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmClose}
        onOpenChange={(value) => {
          if (!config.busy) setConfirmClose(value);
        }}
      >
        <DialogContent>
          <DialogTitle>保存 Agent 配置修改？</DialogTitle>
          <DialogDescription className="mt-2">
            关闭设置前可以保存，或放弃本次修改。已有会话不会受到影响。
          </DialogDescription>
          {config.error && <p role="alert">{config.error}</p>}
          {!valid && <p>请返回编辑，解决工具与 Skills 的配置冲突后再保存。</p>}
          <div className="dialog-actions">
            <Button variant="ghost" disabled={config.busy} onClick={() => setConfirmClose(false)}>
              继续编辑
            </Button>
            <Button
              variant="outline"
              disabled={config.busy}
              onClick={() => {
                config.reset();
                setConfirmClose(false);
                onOpenChange(false);
              }}
            >
              放弃修改
            </Button>
            <Button
              disabled={config.busy || !valid}
              onClick={() => {
                void config.save().then((saved) => {
                  if (saved) {
                    setConfirmClose(false);
                    onOpenChange(false);
                  }
                });
              }}
            >
              保存并关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
