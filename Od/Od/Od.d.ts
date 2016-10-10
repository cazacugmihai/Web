/// <reference path="Obs.d.ts" />
declare namespace Od {
    var processPendingOdEventsDelay: number;
    type Vdom = number | string | VdomPatcher;
    interface VdomPatcher {
        (dom: Node, parent: Node): Node;
        key?: string | number;
        dispose?: () => void;
    }
    type LifecycleFn = (what: string, dom: Node) => void;
    type Vdoms = Vdom | Vdom[];
    const flattenVdoms: (xs: Vdoms) => Vdom[];
    interface Props {
        [prop: string]: any;
    }
    const element: (tag: string, props?: Props, children?: Vdoms) => Vdom;
    type ComponentName = string | number;
    var deferComponentUpdates: boolean;
    const component: (name: string | number, fn: () => Vdom) => Vdom;
    const dispose: (vdom: Vdom) => void;
    const fromHtml: (html: string) => Vdom;
    const fromDom: (srcDom: Node) => Vdom;
    const bind: (vdom: Vdom, dom: Node) => Node;
    const appendChild: (vdom: Vdom, parent: Node) => Node;
}
