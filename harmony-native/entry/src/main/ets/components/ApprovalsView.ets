import { pasteboard } from '@kit.BasicServicesKit';
import { controller } from '../RemoteController';
import { AppState, PendingApproval } from '../model/AppState';
import { ApprovalOption, ApprovalParam, ApprovalQuestion } from '../protocol/Protocol';
import { CodeSpanPart, CodeSpans } from '../logic/CodeSpans';
import { TimeText } from '../logic/TimeText';
import { RcColors } from '../common/Theme';

/** 复制到手机剪贴板 */
function copyText(text: string): void {
  try {
    pasteboard.getSystemPasteboard().setDataSync(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text));
    controller.toast('已复制');
  } catch (e) {
    controller.toast('没能复制');
  }
}

/** 审批和提问面板（对照安卓端 ui/ApprovalsSheet.kt，docs/09）。从底部弹出 */
@ComponentV2
export struct ApprovalsView {
  private s: AppState = controller.state;

  private manyHosts(): boolean {
    return new Set<string>(this.s.approvals.map((a: PendingApproval) => a.hostId)).size > 1;
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#99000000')
        .onClick(() => controller.closeApprovals())
      Column() {
        Text(`等你处理（${this.s.approvals.length}）`)
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .fontColor(RcColors.Text)
          .padding({ left: 20, right: 20, top: 16, bottom: 8 })
          .width('100%')
        List() {
          ForEach(this.s.approvals, (a: PendingApproval) => {
            ListItem() {
              ApprovalCard({ a: a, manyHosts: this.manyHosts(), busy: this.s.answering.includes(a.item.id) })
            }
          }, (a: PendingApproval) => a.item.id)
        }
        .layoutWeight(1)
        .padding({ bottom: 24 })
      }
      .width('100%')
      .height('88%')
      .backgroundColor(RcColors.Bg)
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
  }
}

@ComponentV2
struct ApprovalCard {
  @Require @Param a: PendingApproval;
  @Param manyHosts: boolean = false;
  @Param busy: boolean = false;
  /** 每个问题选中的选项 */
  @Local picked: string[][] = [];
  /** 每个问题自己填的文字 */
  @Local custom: string[] = [];
  /** 拒绝并说明：为 null 时对话框不显示 */
  @Local denyNote: string | null = null;
  /** 展开了的长参数 */
  @Local expandedParams: string[] = [];

  aboutToAppear(): void {
    const n = this.a.item.questions.length;
    this.picked = new Array<string[]>(n).fill([]);
    this.custom = new Array<string>(n).fill('');
  }

  private subtitle(): string {
    const item = this.a.item;
    const parts: string[] = [];
    if (item.cwd.length > 0) {
      parts.push(item.cwd);
    }
    const ago = TimeText.ago(item.createdAt, Date.now());
    if (ago.length > 0) {
      parts.push(ago);
    }
    if (item.agent.length > 0) {
      parts.push(`子代理 ${item.agent}`);
    }
    return parts.join(' · ');
  }

  private answer(choice: string, text: string, answers: Record<string, string | string[]> | null): void {
    if (!controller.answerApproval(this.a.hostId, this.a.item.id, choice, text, answers)) {
      controller.toast('和服务器的连接断开了，没能提交');
    }
  }

  /** 每个问题都答了才返回答案，否则返回 null */
  private answers(): Record<string, string | string[]> | null {
    const out: Record<string, string | string[]> = {};
    const qs = this.a.item.questions;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const sel = this.picked[i] ?? [];
      const text = (this.custom[i] ?? '').trim();
      if (q.multiSelect && (sel.length > 0 || text.length > 0)) {
        const labels = q.options.map((o: ApprovalOption) => o.label).filter((l: string) => sel.includes(l));
        out[q.question] = text.length > 0 ? labels.concat([text]) : labels;
      } else if (!q.multiSelect && text.length > 0) {
        out[q.question] = text;
      } else if (!q.multiSelect && sel.length > 0) {
        out[q.question] = sel[0];
      } else {
        return null;
      }
    }
    return out;
  }

  private pick(i: number, q: ApprovalQuestion, label: string): void {
    const cur = this.picked[i] ?? [];
    let next: string[];
    if (q.multiSelect) {
      next = cur.includes(label) ? cur.filter((l: string) => l !== label) : cur.concat([label]);
    } else {
      next = [label];
      const c = this.custom.slice();
      c[i] = '';
      this.custom = c;
    }
    const p = this.picked.slice();
    p[i] = next;
    this.picked = p;
  }

  private setCustom(i: number, q: ApprovalQuestion, text: string): void {
    const c = this.custom.slice();
    c[i] = text;
    this.custom = c;
    if (!q.multiSelect && text.length > 0) {
      const p = this.picked.slice();
      p[i] = [];
      this.picked = p;
    }
  }

  @Builder
  param(p: ApprovalParam) {
    Column() {
      Row() {
        Text(p.key).fontSize(12).fontColor(RcColors.Muted).layoutWeight(1)
        Text('复制').fontSize(12).fontColor(RcColors.Accent).padding({ left: 4, right: 4, top: 2, bottom: 2 })
          .onClick(() => copyText(p.value))
      }
      .width('100%')

      Text(p.value)
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor(RcColors.Text)
        .copyOption(CopyOptions.LocalDevice)
        .maxLines(this.isLong(p.value) && !this.expandedParams.includes(p.key) ? 8 : 100000)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .padding(8)
        .width('100%')
        .backgroundColor(RcColors.Bg)
        .borderRadius(6)
      if (this.isLong(p.value)) {
        Text(this.expandedParams.includes(p.key) ? '收起' : '展开全部')
          .fontSize(12)
          .fontColor(RcColors.Accent)
          .padding({ top: 4, bottom: 4 })
          .onClick(() => {
            this.expandedParams = this.expandedParams.includes(p.key) ?
            this.expandedParams.filter((k: string) => k !== p.key) : this.expandedParams.concat([p.key]);
          })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .margin({ top: 6 })
  }

  private isLong(v: string): boolean {
    return v.length > 400 || v.split('\n').length > 9;
  }

  /** 问题原文：反引号括起来的命令单独显示成一块，带"复制"按钮 */
  @Builder
  textWithCode(text: string) {
    ForEach(CodeSpans.split(text), (part: CodeSpanPart) => {
      if (part.code) {
        Row() {
          Text(part.text)
            .fontSize(13)
            .fontFamily('monospace')
            .fontColor(RcColors.Text)
            .copyOption(CopyOptions.LocalDevice)
            .padding(8)
            .layoutWeight(1)
          Button('复制', { buttonStyle: ButtonStyleMode.TEXTUAL })
            .fontColor(RcColors.Accent)
            .onClick(() => copyText(part.text))
        }
        .width('100%')
        .backgroundColor(RcColors.Bg)
        .borderRadius(6)
        .margin({ top: 4, bottom: 4 })
      } else if (part.text.trim().length > 0) {
        Text(part.text.trim())
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(RcColors.Text)
          .copyOption(CopyOptions.LocalDevice)
      }
    }, (part: CodeSpanPart, i: number) => `${i}:${part.code}:${part.text}`)
  }

  @Builder
  question(q: ApprovalQuestion, i: number) {
    Column() {
      if (q.header.length > 0) {
        Text(q.header).fontSize(12).fontColor(RcColors.Accent)
      }
      this.textWithCode(q.question)
      ForEach(q.options, (o: ApprovalOption) => {
        Row({ space: 8 }) {
          if (q.multiSelect) {
            Checkbox().select((this.picked[i] ?? []).includes(o.label)).selectedColor(RcColors.Accent)
              .shape(CheckBoxShape.ROUNDED_SQUARE)
              .hitTestBehavior(HitTestMode.None)
          } else {
            Radio({ value: o.label, group: `${q.question}` }).checked((this.picked[i] ?? []).includes(o.label))
              .radioStyle({ checkedBackgroundColor: RcColors.Accent })
              .hitTestBehavior(HitTestMode.None)
          }
          Column() {
            Text(o.label).fontSize(14).fontColor(RcColors.Text)
            if (o.description.length > 0) {
              Text(o.description).fontSize(12).fontColor(RcColors.Muted)
            }
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .constraintSize({ minHeight: 40 })
        .padding({ top: 2, bottom: 2 })
        .onClick(() => this.pick(i, q, o.label))
      }, (o: ApprovalOption) => o.label)
      TextArea({ text: this.custom[i] ?? '', placeholder: q.multiSelect ? '另外补充（可不填）' : '或者自己填' })
        .fontSize(14)
        .constraintSize({ maxHeight: 110 })
        .onChange((v: string) => this.setCustom(i, q, v))
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .margin({ bottom: 8 })
  }

  build() {
    Column() {
      Text((this.manyHosts ? `${this.a.hostName} · ` : '') + this.a.item.title)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(RcColors.Text)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.subtitle().length > 0) {
        Text(this.subtitle()).fontSize(12).fontColor(RcColors.Muted).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      Blank().height(10)
      if (this.a.item.kind === 'ask') {
        ForEach(this.a.item.questions, (q: ApprovalQuestion, i: number) => {
          this.question(q, i)
        }, (q: ApprovalQuestion, i: number) => `${i}:${q.question}`)
        if (this.busy) {
          Text('已提交，等电脑确认…').fontSize(13).fontColor(RcColors.Muted)
        } else {
          Row({ space: 8 }) {
            Button('提交')
              .backgroundColor(RcColors.Accent)
              .fontColor(RcColors.AccentText)
              .enabled(this.answers() !== null)
              .onClick(() => {
                const ans = this.answers();
                if (ans !== null) {
                  this.answer('allow', '', ans);
                }
              })
            Button('不回答', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Accent)
              .onClick(() => this.answer('deny', '', null))
          }
        }
      } else {
        Text(this.a.item.tool).fontSize(14).fontWeight(FontWeight.Medium).fontColor(RcColors.Accent)
        if (this.a.item.description.length > 0) {
          Text(this.a.item.description).fontSize(14).fontColor(RcColors.Text)
        }
        ForEach(this.a.item.params, (p: ApprovalParam) => {
          this.param(p)
        }, (p: ApprovalParam) => p.key)
        if (!this.a.item.complete) {
          Text('有参数太长，手机上没有显示全').fontSize(12).fontColor(RcColors.Warn)
        }
        Blank().height(10)
        if (this.busy) {
          Text('已提交，等电脑确认…').fontSize(13).fontColor(RcColors.Muted)
        } else {
          Row({ space: 8 }) {
            Button('允许')
              .backgroundColor(RcColors.Accent)
              .fontColor(RcColors.AccentText)
              .onClick(() => this.answer('allow', '', null))
            Button('拒绝')
              .backgroundColor(RcColors.Card)
              .fontColor(RcColors.Text)
              .border({ width: 1, color: RcColors.Line })
              .onClick(() => this.answer('deny', '', null))
            Button('拒绝并说明', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Accent)
              .onClick(() => {
                this.denyNote = '';
                // 输入框出来后把焦点给它，软键盘直接弹出来
                setTimeout(() => {
                  try {
                    this.getUIContext().getFocusController().requestFocus(`deny-${this.a.item.id}`);
                  } catch (e) {
                    // 没聚焦上就让用户自己点
                  }
                }, 100);
              })
          }
        }
        if (this.denyNote !== null && !this.busy) {
          // 拒绝并说明：就地展开一个输入框，说明原样转给 Claude
          TextArea({ text: this.denyNote ?? '', placeholder: '告诉 Claude 为什么拒绝、应该怎么做' })
            .height(100)
            .margin({ top: 8 })
            .id(`deny-${this.a.item.id}`)
            .onChange((v: string) => {
              this.denyNote = v;
            })
          Row({ space: 8 }) {
            Button('拒绝')
              .backgroundColor(RcColors.Accent)
              .fontColor(RcColors.AccentText)
              .onClick(() => {
                const note = (this.denyNote ?? '').trim();
                this.denyNote = null;
                this.answer('deny', note, null);
              })
            Button('取消', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Muted)
              .onClick(() => {
                this.denyNote = null;
              })
          }
          .margin({ top: 8 })
        }
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .margin({ left: 12, right: 12, top: 6, bottom: 6 })
    .backgroundColor(RcColors.Card)
    .borderRadius(10)
  }
}
