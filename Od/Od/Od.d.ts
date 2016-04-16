/// <reference path="Obs.d.ts" />
declare namespace Od {
    interface IVdom {
    }
    type Vdom = string | IVdom;
    type Vdoms = Vdom | Vdom[];
    interface IProps {
        [prop: string]: any;
    }
    const text: (text: string) => IVdom;
    const element: (tag: string, props?: IProps, childOrChildren?: string | IVdom | (string | IVdom)[]) => IVdom;
    type ComponentName = string | number;
    function component<T>(name: ComponentName, fn: (x?: T) => Vdom, x?: T): IVdom;
    function component<T>(name: ComponentName, obs: Obs.IObservable<Vdom>): IVdom;
    const fromHtml: (html: string) => IVdom;
    const fromDom: (dom: Node) => IVdom;
    const bind: (vdom: string | IVdom, dom: Node) => void;
    const appendChild: (vdom: string | IVdom, domParent: Node) => void;
    const dispose: (vdom: IVdom) => void;
    var deferComponentUpdates: boolean;
    interface ISubComponents {
        [name: string]: (IVdom | IVdom[]);
    }
    interface IVdom {
        isIVdom: boolean;
        text?: string;
        tag?: string;
        props?: IProps;
        children?: Vdom[];
        obs?: Obs.IObservable<Vdom>;
        subscription?: Obs.ISubscription;
        subcomponents?: ISubComponents;
        dom?: Node;
    }
    const patchDom: (vdomOrString: string | IVdom, dom: Node, domParent?: Node) => Node;
    type PropAssocList = any[];
}