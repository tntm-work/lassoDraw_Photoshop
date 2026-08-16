/*
<javascriptresource>
<name>lassoDraw Toggle</name>
<category>lassoDraw</category>
<about>lassoDraw パネルの有効 / 無効を切り替えます。
Photoshop の「編集 > キーボードショートカット」で
「ファイル > スクリプト > lassoDraw Toggle」にキーを割り当ててください。</about>
</javascriptresource>
*/

/*
 * このスクリプト自体は何も行いません。
 *
 * Photoshop はスクリプトの実行を "AdobeScriptAutomation Scripts" アクションイベントとして
 * ブロードキャストし、そのディスクリプタにはスクリプト名 (javaScriptName) が入ります。
 * lassoDraw パネルはこのイベントを監視していて、名前が一致したときに
 * 有効 / 無効を切り替えます。
 *
 * UXP には独自のグローバルキーボードショートカットを登録する API が無いため、
 * 「Photoshop のスクリプトにショートカットを割り当てる」という Photoshop 側の
 * 仕組みを間借りしています。
 */

// no-op
