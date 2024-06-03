import { Component, Input, OnInit } from '@angular/core';
import {NotificationsService, NotificationType} from 'angular2-notifications';
import {TranslateService} from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { AuthenticationGuard } from 'app/shared/guards/authentication.guard';
import { BaseComponent } from 'app/shared/components/base.component';

@Component({
  selector: 'app-plugins',
  templateUrl: './plugins.component.html',
  styleUrls: ['./plugins.component.scss']
})
export class PluginsComponent extends BaseComponent implements OnInit {

  @Input('testInput') testInput: string;
  constructor(
    public authGuard: AuthenticationGuard,
    public notificationsService: NotificationsService,
    public translate: TranslateService,
    public toastrService: ToastrService) {
    
    super(authGuard, notificationsService, translate, toastrService);
  }

  ngOnInit(): void {
    super.showNotification(NotificationType.Error, "<b style='color: red'>Baka onii-chan?</b>");
    super.showNotification(NotificationType.Alert, "Sussy baka?");
    super.showNotification(NotificationType.Success, "Hehe :))");
  }

  showNotification(type: NotificationType, message, clickToClose?:boolean) {
    if(type == NotificationType.Success){
      super.showNotification(type, message);
      return;
    }
    const temp = {
      type: type,
      title: message,
      timeOut: 0,
      showProgressBar: true,
      pauseOnHover: true,
      animate: 'fromLeft',
      showCloseButton: true,
      enableHtml: true,
      clickToClose: false,
      clickIconToClose: true,
      theClass: "paused-notification",
    };
    let notification = this.notificationsService.create(temp.title, "", temp.type, temp);
    notification.click.subscribe((event)=>{
      if(event["target"] == document.querySelector(".icon")){
        this.notificationsService.remove(notification.id);
      }
    })
  }

}
