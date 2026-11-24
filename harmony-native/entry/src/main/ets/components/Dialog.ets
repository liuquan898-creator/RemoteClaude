import { RcColors } from '../common/Theme';

/** 页面里的对话框：半透明底 + 居中的卡片。用 if 控制显示，点底板关闭 */
@ComponentV2
export struct RcDialog {
  @Param title: string = '';
  @Param message: string = '';
  @Param confirmText: string = '确定';
  @Param cancelText: string = '取消';
  @Param confirmEnabled: boolean = true;
  @Event onConfirm: () => void = () => {
  };
  @Event onCancel: () => void = () => {
  };
  @BuilderParam content: () => void = this.noContent;

  @Builder
  noContent() {
  }

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#99000000')
        .onClick(() => this.onCancel())
      Column({ space: 12 }) {
        if (this.title.length > 0) {
          Text(this.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor(RcColors.Text)
        }
        if (this.message.length > 0) {
          Text(this.message).fontSize(14).fontColor(RcColors.Muted)
        }
        this.content()
        Row({ space: 8 }) {
          Blank()
          if (this.cancelText.length > 0) {
            Button(this.cancelText, { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Muted)
              .onClick(() => this.onCancel())
          }
          Button(this.confirmText, { buttonStyle: ButtonStyleMode.TEXTUAL })
            .fontColor(RcColors.Accent)
            .enabled(this.confirmEnabled)
            .onClick(() => this.onConfirm())
        }
        .width('100%')
      }
      .width('86%')
      .constraintSize({ maxWidth: 420 })
      .padding(20)
      .backgroundColor(RcColors.Card)
      .borderRadius(16)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
  }
}
