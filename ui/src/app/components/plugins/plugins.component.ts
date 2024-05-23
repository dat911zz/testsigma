import { Component, Input, OnInit } from '@angular/core';

@Component({
  selector: 'app-plugins',
  templateUrl: './plugins.component.html',
  styleUrls: ['./plugins.component.scss']
})
export class PluginsComponent implements OnInit {

  @Input('testInput') testInput: string;
  constructor() { }

  ngOnInit(): void {
//     console.log("Kết quả nhận từ input: " + this.testInput);
  }

}
